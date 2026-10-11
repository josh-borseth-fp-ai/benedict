import { createRequire } from "node:module"
import { NodeServices } from "@effect/platform-node"
import { Console, Effect, Layer, Option } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { AppGitHub } from "./app-github.js"
import { checkFindings, readFindings } from "./check.js"
import { collectSnapshot, loadReviewSkills } from "./context.js"
import { Git, repositoryRoot } from "./git.js"
import { GitHub } from "./github.js"
import { readAppCredentials } from "./infisical.js"
import { publishReview } from "./publish.js"
import { resolvePullRequest } from "./pull-request.js"
import { ReviewError, configPath } from "./model.js"
import type { CheckReport, ReviewContext, ReviewOptions } from "./model.js"
import { setup } from "./setup.js"

const rangeFlags = {
  repo: Flag.String("repo").pipe(Flag.withDefault("."), Flag.withDescription("Repository directory")),
  base: Flag.String("base").pipe(Flag.optional, Flag.withDescription("Base commit; defaults to HEAD~1, or HEAD with --worktree")),
  head: Flag.String("head").pipe(Flag.optional, Flag.withDescription("Head commit; defaults to HEAD")),
  worktree: Flag.Boolean("worktree").pipe(Flag.withDefault(false), Flag.withDescription("Review staged, unstaged and untracked files against the base")),
  format: Flag.Literals("format", ["json", "text"]).pipe(Flag.withDefault("json"), Flag.withDescription("Output format; defaults to JSON"))
}

type RangeFlags = Command.Command.Config.Infer<typeof rangeFlags>

const optionsFrom = (flags: RangeFlags): ReviewOptions => ({
  repo: flags.repo,
  base: Option.getOrUndefined(flags.base),
  head: Option.getOrUndefined(flags.head),
  worktree: flags.worktree
})

const rangeText = (context: Pick<ReviewContext, "range">) => `${context.range.base} → ${context.range.head ?? "worktree"}`
const contextText = (context: ReviewContext): string => [
  `Repository: ${context.repository}`,
  `Range: ${rangeText(context)}`,
  ...(context.pullRequest ? [`Pull request: ${context.pullRequest.url}`] : []),
  ...(context.organization ? [`Organization: ${context.organization.source} @ ${context.organization.revision}`] : []),
  "Skills:",
  ...context.skills.map((skill) => `- ${skill.name} (${skill.scope}${skill.paths ? `; ${skill.paths.join(", ")}` : ""}): ${skill.description}`),
  "Files:",
  ...context.files.map((file) => `${file.status} ${JSON.stringify(file.path)} (${file.reviewable ? `${file.lineCount} lines; ${file.skills.join(", ") || "no skills apply"}` : "not reviewable"})`),
  ...(context.files.length === 0 ? ["No changed files."] : [])
].join("\n")

const reportText = (report: CheckReport): string => [
  `Range: ${rangeText(report)}`,
  ...(report.organization ? [`Organization: ${report.organization.source} @ ${report.organization.revision}`] : []),
  `Accepted: ${report.summary.accepted}; rejected: ${report.summary.rejected}`,
  ...report.accepted.map((finding) => `${finding.severity} [${finding.skill}] ${JSON.stringify(finding.file)}:${finding.startLine}-${finding.endLine} ${finding.title}\n${finding.explanation}\nQuote: ${JSON.stringify(finding.quote)}\nConfidence: ${finding.confidence}${finding.suggestedFix === undefined ? "" : `\nSuggested fix: ${finding.suggestedFix}`}`),
  ...report.rejected.map((item) => `Rejected draft ${item.index}: ${item.reasons.map((reason) => `${reason.code}: ${reason.message}`).join("; ")}`)
].join("\n\n")

const contextCommand = Command.make("context", {
  ...rangeFlags,
  pr: Flag.String("pr").pipe(Flag.optional, Flag.withDescription("Full GitHub PR URL; reviews its merge base (or --base) through its current head, fetching missing commits"))
}, Effect.fn(function*(flags) {
  const options = optionsFrom(flags)
  const pr = Option.getOrUndefined(flags.pr)
  if (pr !== undefined && (options.worktree || options.head !== undefined)) {
    return yield* new ReviewError({ code: "range_error", message: "--pr selects the PR head; it cannot be combined with --head or --worktree." })
  }
  const resolved = pr === undefined ? undefined : yield* resolvePullRequest(options.repo, pr, options.base)
  const snapshot = yield* collectSnapshot(resolved === undefined ? options : { ...options, base: resolved.base, head: resolved.head })
  const context: ReviewContext = resolved === undefined ? snapshot.context : { ...snapshot.context, pullRequest: { url: resolved.url } }
  yield* Console.log(flags.format === "json" ? JSON.stringify(context, null, 2) : contextText(context))
})).pipe(Command.withDescription("Gather changed files, patches and the review skills that apply to each file."))

const skillCommand = Command.make("skill", {
  repo: rangeFlags.repo,
  base: Flag.String("base").pipe(Flag.withDescription("The review's resolved base commit, from context's range.base")),
  name: Argument.String("name").pipe(Argument.withDescription("Review skill name from context's skills list"))
}, Effect.fn(function*(flags) {
  const root = yield* repositoryRoot(flags.repo)
  const base = yield* Git.use((git) => git.run(root, ["rev-parse", "--verify", "--end-of-options", `${flags.base}^{commit}`])).pipe(
    Effect.mapError(() => new ReviewError({ code: "range_error", message: `Cannot resolve commit ${JSON.stringify(flags.base)}. Pass the base from benedict context.` }))
  )
  const { skills } = yield* loadReviewSkills(root, base.trim())
  const skill = skills.find((item) => item.name === flags.name)
  if (skill === undefined) return yield* new ReviewError({ code: "skill_error", message: `No review skill named ${JSON.stringify(flags.name)}. Available: ${skills.map((item) => item.name).join(", ")}.` })
  yield* Console.log(skill.content.trimEnd())
})).pipe(Command.withDescription("Print a review skill's instructions: the latest organization version, or as committed at the review's base."))

const checkCommand = Command.make("check", {
  ...rangeFlags,
  findings: Argument.String("findings").pipe(Argument.withDescription("Findings JSON file; relative to the current directory"))
}, Effect.fn(function*(flags) {
  const drafts = yield* readFindings(flags.findings)
  const snapshot = yield* collectSnapshot(optionsFrom(flags))
  const report = yield* checkFindings(snapshot, drafts)
  yield* Console.log(flags.format === "json" ? JSON.stringify(report, null, 2) : reportText(report))
  yield* Effect.sync(() => { process.exitCode = report.summary.rejected > 0 ? 1 : 0 })
})).pipe(Command.withDescription("Validate finding structure, source evidence and repository policy."))

const setupCommand = Command.make("setup", {
  repo: rangeFlags.repo,
  organization: Flag.String("organization").pipe(Flag.optional, Flag.withDescription("Organization skills Git URL or local repository path; reviews always use its latest default branch")),
  agent: Flag.String("agent").pipe(Flag.atLeast(0), Flag.withDescription("Agent to install the skill for; repeat, or use '*' for all supported agents")),
  global: Flag.Boolean("global").pipe(Flag.withDefault(false), Flag.withDescription("Install for this user across projects (the default)")),
  project: Flag.Boolean("project").pipe(Flag.withDefault(false), Flag.withDescription("Install the skill into this repository")),
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false), Flag.withDescription("Skip installer prompts; requires explicit --agent selections")),
  skipSkills: Flag.Boolean("skip-skills").pipe(Flag.withDefault(false), Flag.withDescription("Only connect organization skills; keep the existing Benedict skill installation"))
}, Effect.fn(function*(flags) {
  if (flags.global && flags.project) return yield* Effect.fail(new Error("--global and --project cannot be combined."))
  const result = yield* setup({
    repo: flags.repo,
    organization: Option.getOrUndefined(flags.organization),
    project: flags.project, agents: flags.agent, yes: flags.yes, skipSkills: flags.skipSkills
  })
  yield* Console.log([
    result.skillInstalled ? `Installed the Benedict skill (${result.scope} scope).` : "Skill installation skipped.",
    ...(result.organization ? [`Organization skills: ${result.organization.source} (latest revision ${result.organization.revision}); every review fetches the latest.`] : []),
    ...(result.configChanged ? [`Review and commit ${configPath}.`] : []),
    "Ask your coding agent to use the benedict skill to review your change."
  ].join("\n"))
})).pipe(Command.withDescription("Install the bundled skill and connect this repository to organization knowledge."))

const publishCommand = Command.make("publish", {
  repo: rangeFlags.repo,
  base: Flag.String("base").pipe(Flag.optional, Flag.withDescription("Reviewed base; defaults to the PR merge base")),
  head: rangeFlags.head,
  format: rangeFlags.format,
  findings: Argument.String("findings").pipe(Argument.withDescription("Draft findings JSON; revalidated before posting")),
  pr: Flag.String("pr").pipe(Flag.withDescription("Full https://github.com/OWNER/REPO/pull/NUMBER URL")),
  contextFile: Flag.String("context-file").pipe(Flag.optional, Flag.withDescription("Markdown file with useful review context")),
  confidence: Flag.Int("confidence").pipe(Flag.withDescription("Overall merge confidence (1-5)")),
  decision: Flag.Literals("decision", ["approve", "comment"]).pipe(Flag.withDescription("Your call on whether the PR is safe to approve: approve, or comment without approving")),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("Render the exact review without posting it; reads the PR and its diff and needs no app credentials"))
}, Effect.fn(function*(flags) {
  const result = yield* publishReview({
    findings: flags.findings,
    pr: flags.pr,
    repo: flags.repo,
    base: Option.getOrUndefined(flags.base),
    head: Option.getOrUndefined(flags.head),
    contextFile: Option.getOrUndefined(flags.contextFile),
    confidence: flags.confidence,
    decision: flags.decision,
    dryRun: flags.dryRun
  })
  const approval = result.approval === null ? [] : [result.approval.action === "refused"
    ? `approval refused (${result.approval.code}): ${result.approval.message}`
    : `approval ${result.approval.action}: ${result.approval.url}`]
  const comments = result.comments.map((comment) => `--- ${comment.path}:${comment.startLine === comment.line ? comment.line : `${comment.startLine}-${comment.line}`} ---\n${comment.body}`)
  yield* Console.log(flags.format === "json" ? JSON.stringify(result, null, 2) : [`${result.action}: ${result.reviewUrl ?? result.pr}`, ...approval, "", result.body, ...comments].join("\n"))
  // An approval that was refused still published the review; exit 1 tells the agent to request human review.
  yield* Effect.sync(() => { process.exitCode = result.approval?.action === "refused" ? 1 : 0 })
})).pipe(Command.withDescription("Post validated findings and context as a Benedict GitHub App review, and approve the PR when you decide it is safe."))

export const benedictCommand = Command.make("benedict").pipe(
  Command.withDescription("Benedict: deterministic code review tools for coding agents."),
  Command.withSubcommands([contextCommand, skillCommand, checkCommand, publishCommand, setupCommand])
)

const { version } = createRequire(import.meta.url)("../package.json") as { version: string }

// App credentials are read from Infisical only when a command posts to GitHub.
const appGitHub = AppGitHub.layer(readAppCredentials()).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "error" }))
)

export const run = Command.run(benedictCommand, { version }).pipe(
  Effect.provide(Git.layer),
  Effect.provide(appGitHub),
  Effect.provide(GitHub.layer),
  Effect.provide(NodeServices.layer),
  Effect.catch((error) => Effect.gen(function*() {
    // CLI parse errors already have help rendered by Command.run.
    if (!CliError.isCliError(error)) {
      yield* Console.error(JSON.stringify({
        error: {
          code: typeof error === "object" && error !== null && "code" in error ? error.code : "operation_error",
          message: error instanceof Error ? error.message : String(error)
        }
      }))
    }
    yield* Effect.sync(() => {
      process.exitCode = CliError.isCliError(error) && error._tag === "ShowHelp" && error.errors.length === 0 ? 0 : 2
    })
  }))
)
