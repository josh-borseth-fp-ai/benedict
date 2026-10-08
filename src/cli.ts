import { NodeServices } from "@effect/platform-node"
import { Console, Effect, Option } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { checkFindings, readFindings } from "./check.js"
import { collectSnapshot } from "./context.js"
import { Git } from "./git.js"
import { GitHub } from "./github.js"
import { publishReview } from "./publish.js"
import type { CheckReport, ReviewContext, ReviewOptions } from "./model.js"
import { setup } from "./setup.js"
import { repositoryRoot, syncOrganization } from "./sync.js"

const rangeFlags = {
  repo: Flag.String("repo").pipe(Flag.withDefault("."), Flag.withDescription("Repository directory")),
  base: Flag.String("base").pipe(Flag.optional, Flag.withDescription("Base commit; defaults to HEAD~1, or HEAD with --worktree")),
  head: Flag.String("head").pipe(Flag.optional, Flag.withDescription("Head commit; defaults to HEAD")),
  worktree: Flag.Boolean("worktree").pipe(Flag.withDefault(false), Flag.withDescription("Review staged, unstaged and untracked files against the base")),
  config: Flag.String("config").pipe(Flag.optional, Flag.withDescription("Config path, relative to the repository root")),
  format: Flag.Literals("format", ["json", "text"]).pipe(Flag.withDefault("json"), Flag.withDescription("Output format; defaults to JSON"))
}

type RangeFlags = Command.Command.Config.Infer<typeof rangeFlags>

const optionsFrom = (flags: RangeFlags): ReviewOptions => ({
  repo: flags.repo,
  base: Option.getOrUndefined(flags.base),
  head: Option.getOrUndefined(flags.head),
  worktree: flags.worktree,
  config: Option.getOrUndefined(flags.config)
})

const rangeText = (context: Pick<ReviewContext, "range">) => `${context.range.base} → ${context.range.head ?? "worktree"}`
const contextText = (context: ReviewContext): string => [
  `Repository: ${context.repository}`,
  `Range: ${rangeText(context)}`,
  `Policy: severity >= ${context.config.minimumSeverity}, confidence >= ${context.config.minimumConfidence}`,
  ...(context.config.organization ? [`Organization: ${context.config.organization.source} @ ${context.config.organization.revision}`] : []),
  ...context.files.map((file) => `${file.status} ${JSON.stringify(file.path)} (${file.reviewable ? `${file.lineCount} lines; ${file.skills.join(", ") || "no permitted lenses"}` : "not reviewable"})`),
  ...(context.files.length === 0 ? ["No changed files."] : []),
  "Review rules:",
  ...context.config.rules.map((rule) => `- ${rule}`),
  ...context.config.knowledge.map((document) => `\nKnowledge [${document.scope}] ${document.path}:\n${document.content}`)
].join("\n")

const reportText = (report: CheckReport): string => [
  `Range: ${rangeText(report)}`,
  ...(report.organization ? [`Organization: ${report.organization.source} @ ${report.organization.revision}`] : []),
  `Accepted: ${report.summary.accepted}; rejected: ${report.summary.rejected}`,
  ...report.accepted.map((finding) => `${finding.severity} [${finding.skill}] ${JSON.stringify(finding.file)}:${finding.startLine}-${finding.endLine} ${finding.title}\n${finding.explanation}\nQuote: ${JSON.stringify(finding.quote)}\nConfidence: ${finding.confidence}${finding.suggestedFix === undefined ? "" : `\nSuggested fix: ${finding.suggestedFix}`}`),
  ...report.rejected.map((item) => `Rejected draft ${item.index}: ${item.reasons.map((reason) => `${reason.code}: ${reason.message}`).join("; ")}`)
].join("\n\n")

const contextCommand = Command.make("context", rangeFlags, Effect.fn(function*(flags) {
  const snapshot = yield* collectSnapshot(optionsFrom(flags))
  yield* Console.log(flags.format === "json" ? JSON.stringify(snapshot.context, null, 2) : contextText(snapshot.context))
})).pipe(Command.withDescription("Gather changed files, patches and applicable review policy."))

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

const syncCommand = Command.make("sync", {
  repo: rangeFlags.repo,
  config: rangeFlags.config,
  format: rangeFlags.format,
  update: Flag.Boolean("update").pipe(Flag.withDefault(false), Flag.withDescription("Resolve the configured ref again and update the committed knowledge lock"))
}, Effect.fn(function*(flags) {
  const root = yield* repositoryRoot(flags.repo)
  const result = yield* syncOrganization(root, Option.getOrUndefined(flags.config), flags.update)
  yield* Console.log(flags.format === "json" ? JSON.stringify(result, null, 2) :
    `Organization: ${result.organization.source}\nRevision: ${result.organization.revision}\nKnowledge files: ${result.knowledgeFiles.length}\n${result.lockChanged ? "Updated .review/knowledge.lock.json; review and commit it." : "Cached locked revision; lock unchanged."}`)
})).pipe(Command.withDescription("Cache the locked organization knowledge; --update explicitly advances its revision."))

const setupCommand = Command.make("setup", {
  repo: rangeFlags.repo,
  config: rangeFlags.config,
  organization: Flag.String("organization").pipe(Flag.optional, Flag.withDescription("Organization knowledge Git URL or local repository path")),
  ref: Flag.String("ref").pipe(Flag.optional, Flag.withDescription("Organization branch, tag or commit; defaults to HEAD")),
  agent: Flag.String("agent").pipe(Flag.atLeast(0), Flag.withDescription("Agent to install the skill for; repeat, or use '*' for all supported agents")),
  global: Flag.Boolean("global").pipe(Flag.withDefault(false), Flag.withDescription("Install for this user across projects (the default)")),
  project: Flag.Boolean("project").pipe(Flag.withDefault(false), Flag.withDescription("Install the skill into this repository")),
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false), Flag.withDescription("Skip installer prompts; requires explicit --agent selections")),
  skipSkills: Flag.Boolean("skip-skills").pipe(Flag.withDefault(false), Flag.withDescription("Configure and sync knowledge only; keep existing skill installation"))
}, Effect.fn(function*(flags) {
  if (flags.global && flags.project) return yield* Effect.fail(new Error("--global and --project cannot be combined."))
  const result = yield* setup({
    repo: flags.repo, config: Option.getOrUndefined(flags.config),
    organization: Option.getOrUndefined(flags.organization), ref: Option.getOrUndefined(flags.ref),
    project: flags.project, agents: flags.agent, yes: flags.yes, skipSkills: flags.skipSkills
  })
  yield* Console.log(`${result.skillInstalled ? `Installed the review skill (${result.scope} scope).` : "Skill installation skipped."}\n${result.organization ? `Organization revision: ${result.organization.revision}\nReview and commit review.yaml and .review/knowledge.lock.json.` : "No organization configured; repository rules still apply."}\nAsk your coding agent to use the review skill to review your change.`)
})).pipe(Command.withDescription("Install the bundled skill and connect this repository to organization knowledge."))

const publishCommand = Command.make("publish", {
  repo: rangeFlags.repo,
  base: Flag.String("base").pipe(Flag.optional, Flag.withDescription("Reviewed base; defaults to the PR merge base")),
  head: rangeFlags.head,
  config: rangeFlags.config,
  format: rangeFlags.format,
  findings: Argument.String("findings").pipe(Argument.withDescription("Draft findings JSON; revalidated before posting")),
  pr: Flag.String("pr").pipe(Flag.withDescription("Full https://github.com/OWNER/REPO/pull/NUMBER URL")),
  contextFile: Flag.String("context-file").pipe(Flag.optional, Flag.withDescription("Markdown file with useful review context")),
  dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false), Flag.withDescription("Render the exact comment without writing to GitHub; reads PR metadata"))
}, Effect.fn(function*(flags) {
  const result = yield* publishReview({
    findings: flags.findings,
    pr: flags.pr,
    repo: flags.repo,
    base: Option.getOrUndefined(flags.base),
    head: Option.getOrUndefined(flags.head),
    config: Option.getOrUndefined(flags.config),
    contextFile: Option.getOrUndefined(flags.contextFile),
    dryRun: flags.dryRun
  })
  yield* Console.log(flags.format === "json" ? JSON.stringify(result, null, 2) : `${result.action}: ${result.commentUrl ?? result.pr}\n\n${result.body}`)
})).pipe(Command.withDescription("Publish validated findings and context as an AI-labeled PR comment via gh."))

export const reviewCommand = Command.make("review").pipe(
  Command.withDescription("Deterministic review tools for coding agents."),
  Command.withSubcommands([contextCommand, checkCommand, publishCommand, syncCommand, setupCommand])
)

export const run = Command.run(reviewCommand, { version: "0.1.0" }).pipe(
  Effect.provide(Git.layer),
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
