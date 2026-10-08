import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { Yaml } from "effect/encoding"
import { Context } from "effect"
import { ConfigError } from "../domain/Errors.js"
import {
  ReviewConfigFile,
  type ResolvedReviewConfig,
  type SkillName
} from "../domain/Model.js"
import { matchGlob } from "./glob.js"

export const defaultRules = [
  "Do not report style-only issues.",
  "Only report findings that can cause a real defect or meaningful risk.",
  "Prefer evidence from the repository over assumptions."
] as const

export const defaultConfig = (overrides?: Partial<ResolvedReviewConfig>): ResolvedReviewConfig => ({
  skills: overrides?.skills ?? ["correctness", "security"],
  minimumSeverity: overrides?.minimumSeverity ?? "medium",
  minimumConfidence: overrides?.minimumConfidence ?? 0.7,
  paths: overrides?.paths ?? [],
  rules: overrides?.rules ?? [...defaultRules]
})

export const resolveConfigFile = (file: ReviewConfigFile): ResolvedReviewConfig =>
  defaultConfig({
    ...(file.skills === undefined ? {} : { skills: file.skills }),
    ...(file.severity === undefined ? {} : { minimumSeverity: file.severity.minimum }),
    ...(file.minimumConfidence === undefined ? {} : { minimumConfidence: file.minimumConfidence }),
    ...(file.paths === undefined ? {} : { paths: file.paths }),
    ...(file.rules === undefined ? {} : { rules: file.rules })
  })

export const skillsForPath = (
  config: ResolvedReviewConfig,
  path: string
): ReadonlyArray<SkillName> => {
  const matching = config.paths.filter((rule) => matchGlob(rule.pattern, path))
  if (matching.length === 0) return config.skills
  const allowed = new Set(matching.flatMap((rule) => [...rule.skills]))
  return config.skills.filter((skill) => allowed.has(skill))
}

const decodeConfig = (text: string, format: "json" | "yaml") =>
  Effect.try({
    try: () => format === "json" ? JSON.parse(text) as unknown : Yaml.parse(text),
    catch: (cause) => new ConfigError({
      message: `Could not parse review config as ${format}`,
      detail: cause instanceof Error ? cause.message : String(cause)
    })
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(ReviewConfigFile)(value).pipe(
        Effect.mapError((cause) => new ConfigError({
          message: "Review config does not match the expected schema",
          detail: String(cause)
        }))
      )
    ),
    Effect.map(resolveConfigFile)
  )

export class ReviewConfigStore extends Context.Service<ReviewConfigStore, {
  readonly load: (root: string) => Effect.Effect<ResolvedReviewConfig, ConfigError>
  readonly projectNotes: (root: string) => Effect.Effect<ReadonlyArray<{ readonly path: string; readonly text: string }>, ConfigError>
}>()("review-runtime/ReviewConfigStore") {
  static readonly layer = Layer.effect(
    ReviewConfigStore,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path

      const readIfExists = (absolute: string) =>
        fs.exists(absolute).pipe(
          Effect.flatMap((exists) => exists ? fs.readFileString(absolute) : Effect.succeed(undefined)),
          Effect.mapError((cause) => new ConfigError({
            message: `Could not read ${absolute}`,
            detail: cause instanceof Error ? cause.message : String(cause)
          }))
        )

      const load = Effect.fn("ReviewConfig.load")(function*(root: string) {
        const candidates = [
          ["review.yaml", "yaml"],
          ["review.yml", "yaml"],
          ["review.json", "json"]
        ] as const
        for (const [name, format] of candidates) {
          const text = yield* readIfExists(paths.join(root, name))
          if (text === undefined) continue
          return yield* decodeConfig(text, format)
        }
        return defaultConfig()
      })

      const projectNotes = Effect.fn("ReviewConfig.projectNotes")(function*(root: string) {
        const notes: Array<{ path: string; text: string }> = []
        for (const name of ["AGENTS.md", "CLAUDE.md", "CODEOWNERS"]) {
          const text = yield* readIfExists(paths.join(root, name))
          if (text === undefined || text.trim() === "") continue
          notes.push({ path: name, text: text.slice(0, 4000) })
        }
        return notes
      })

      return ReviewConfigStore.of({ load, projectNotes })
    })
  )
}
