import { Effect, FileSystem, Path, Schema } from "effect"
import picomatch from "picomatch"
import { parseDocument } from "yaml"
import { ConfigFile, ReviewError } from "./model.js"
import type { ReviewConfig, Skill } from "./model.js"

const defaultRules = [
  "Do not report style-only issues.",
  "Only report a real defect or a meaningful risk.",
  "Prefer evidence from the repository over assumptions."
]

export const loadConfig = Effect.fn("Review.loadConfig")(function*(root: string, explicit?: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files = explicit === undefined
    ? ["review.yaml", "review.yml", "review.json"].map((name) => path.join(root, name))
    : [path.resolve(root, explicit)]
  const exists = yield* Effect.forEach(files, (file) => fs.exists(file))
  const candidates = files.filter((_, index) => exists[index])
  if (explicit !== undefined && candidates.length === 0) {
    return yield* new ReviewError({ code: "config_error", message: `Config does not exist: ${files[0]}` })
  }
  if (candidates.length > 1) {
    return yield* new ReviewError({ code: "config_error", message: "Multiple review configs found; select one with --config." })
  }
  const source = candidates[0] ?? null
  let decoded: ConfigFile = {}
  if (source !== null) {
    const text = yield* fs.readFileString(source)
    const parsed = yield* Effect.try({
      try: () => {
        if (source.endsWith(".json")) return JSON.parse(text) as unknown
        const document = parseDocument(text, { uniqueKeys: true })
        if (document.errors.length > 0) throw new Error(document.errors.map((e) => e.message).join("; "))
        return document.toJS({ maxAliasCount: 50 }) as unknown
      },
      catch: (error) => new ReviewError({ code: "config_error", message: `Invalid config ${source}: ${String(error)}` })
    })
    decoded = yield* Schema.decodeUnknownEffect(ConfigFile, { onExcessProperty: "error" })(parsed).pipe(
      Effect.mapError((error) => new ReviewError({ code: "config_error", message: `Invalid config ${source}: ${error.message}` }))
    )
    yield* Effect.try({
      try: () => {
        for (const { pattern } of decoded.paths ?? []) {
          if (pattern.startsWith("/") || pattern.includes("\\") || pattern.split("/").includes("..")) {
            throw new Error(`Path pattern must be repository-relative with forward slashes: ${pattern}`)
          }
          picomatch(pattern, { dot: true, strictBrackets: true })
        }
      },
      catch: (error) => new ReviewError({ code: "config_error", message: String(error) })
    })
  }
  return {
    source,
    skills: [...new Set<Skill>(decoded.skills ?? ["correctness", "security"])],
    minimumSeverity: decoded.severity?.minimum ?? "medium",
    minimumConfidence: decoded.minimumConfidence ?? 0.7,
    paths: decoded.paths ?? [],
    rules: decoded.rules ?? defaultRules
  } satisfies ReviewConfig
})

export const skillsForPath = (file: string, config: ReviewConfig): ReadonlyArray<Skill> => {
  const matches = config.paths.filter(({ pattern }) => picomatch.isMatch(file, pattern, { dot: true }))
  if (matches.length === 0) return config.skills
  return config.skills.filter((skill) => matches.some((rule) => rule.skills.includes(skill)))
}
