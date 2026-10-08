import { Config, Effect, Layer, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { claudeLayer, codexLayer } from "./agent/backend.js"
import { BackendName, OutputFormat, Severity } from "./domain/Model.js"
import { Git } from "./git/Git.js"
import { AppLayer } from "./layers.js"
import { ReviewOptions } from "./options.js"
import { ReviewConfigStore } from "./review/config.js"
import { review } from "./review/pipeline.js"
import { renderReport } from "./review/report.js"

const optionalBackend = Flag.Literals("backend", ["codex", "claude"]).pipe(
  Flag.withAlias("b"),
  Flag.withDescription("Official CLI that performs the review"),
  Flag.optional
)

const optionalFormat = Flag.Literals("format", ["text", "json", "both"]).pipe(
  Flag.withDescription("text, json, or both"),
  Flag.optional
)

const optionalConfidence = Flag.Finite("min-confidence").pipe(
  Flag.withDescription("Drop findings below this confidence"),
  Flag.optional
)

const optionalSeverity = Flag.Literals("min-severity", ["low", "medium", "high", "critical"]).pipe(
  Flag.withDescription("Drop findings below this severity"),
  Flag.optional
)

export const reviewCommand = Command.make("review", {
  base: Argument.String("base").pipe(
    Argument.withDescription("Git ref to review against"),
    Argument.withDefault("HEAD~1")
  ),
  head: Flag.String("head").pipe(
    Flag.withDescription("Git ref to review. Ignored with --worktree"),
    Flag.withDefault("HEAD")
  ),
  repo: Flag.String("repo").pipe(
    Flag.withDescription("Repository directory"),
    Flag.withDefault(".")
  ),
  worktree: Flag.Boolean("worktree").pipe(
    Flag.withDescription("Diff the worktree against the base ref"),
    Flag.withDefault(false)
  ),
  backend: optionalBackend,
  format: optionalFormat,
  minConfidence: optionalConfidence,
  minSeverity: optionalSeverity,
  timeoutSeconds: Flag.Int("timeout-seconds").pipe(
    Flag.withDescription("How long an agent CLI may run"),
    Flag.withDefault(600)
  )
}, Effect.fn("review")(function*(flags) {
  const envBackend = yield* Config.String("REVIEW_BACKEND").pipe(Config.withDefault("codex"))
  const backend = yield* Schema.decodeUnknownEffect(BackendName)(
    Option.getOrElse(flags.backend, () => envBackend)
  ).pipe(Effect.mapError((cause) => new Error(`Invalid REVIEW_BACKEND: ${String(cause)}`)))
  const format = Option.getOrElse(flags.format, (): OutputFormat => "both")
  const git = yield* Git
  const root = yield* git.repositoryRoot(flags.repo)
  const configStore = yield* ReviewConfigStore
  const config = yield* configStore.load(root)
  const minConfidence = Option.getOrElse(flags.minConfidence, () => config.minimumConfidence)
  if (minConfidence < 0 || minConfidence > 1) {
    return yield* Effect.fail(new Error("--min-confidence must be between 0 and 1"))
  }
  const minSeverity = yield* Schema.decodeUnknownEffect(Severity)(
    Option.getOrElse(flags.minSeverity, () => config.minimumSeverity)
  )
  const options = {
    repo: root,
    base: flags.base,
    head: flags.head,
    worktree: flags.worktree,
    backend,
    format,
    minConfidence,
    minSeverity,
    timeoutSeconds: flags.timeoutSeconds
  }
  const optionsLayer = Layer.succeed(ReviewOptions, options)
  const agent = Layer.provideMerge(
    backend === "claude" ? claudeLayer : codexLayer,
    optionsLayer
  )
  const report = yield* review().pipe(Effect.provide(agent))
  yield* renderReport(report, format)
})).pipe(
  Command.withDescription("Review a local git range with Codex CLI or Claude Code.")
)

export const run = Command.run(reviewCommand, {
  version: "0.1.0"
}).pipe(Effect.provide(AppLayer))
