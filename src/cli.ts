import { NodeServices } from "@effect/platform-node"
import { Console, Effect, Option } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { checkFindings, readFindings } from "./check.js"
import { collectSnapshot } from "./context.js"
import { Git } from "./git.js"
import { GitHub } from "./github.js"
import { publishReview } from "./publish.js"
import type { CheckReport, ReviewContext, ReviewOptions } from "./model.js"

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
  ...context.files.map((file) => `${file.status} ${JSON.stringify(file.path)} (${file.reviewable ? `${file.lineCount} lines; ${file.skills.join(", ") || "no permitted lenses"}` : "not reviewable"})`),
  ...(context.files.length === 0 ? ["No changed files."] : []),
  "Review rules:",
  ...context.config.rules.map((rule) => `- ${rule}`)
].join("\n")

const reportText = (report: CheckReport): string => [
  `Range: ${rangeText(report)}`,
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
  Command.withSubcommands([contextCommand, checkCommand, publishCommand])
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
