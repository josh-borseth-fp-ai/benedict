import { Effect, FileSystem, Path, Schema } from "effect"
import picomatch from "picomatch"
import { ConfigFile, ReviewError } from "./model.js"
import type { ReviewConfig, Skill } from "./model.js"
import { loadOrganization, readRepositoryKnowledge } from "./knowledge.js"
import { parseConfig, resolvePolicy } from "./policy.js"

export const readRepositoryConfig = Effect.fn("Review.readConfig")(function*(root: string, explicit?: string) {
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
    const parsed = yield* parseConfig(text, source)
    decoded = yield* Schema.decodeUnknownEffect(ConfigFile, { onExcessProperty: "error" })(parsed).pipe(
      Effect.mapError((error) => new ReviewError({ code: "config_error", message: `Invalid config ${source}: ${error.message}` }))
    )
  }
  return { source, decoded }
})

export const loadConfig = Effect.fn("Review.loadConfig")(function*(root: string, explicit?: string) {
  const { source, decoded } = yield* readRepositoryConfig(root, explicit)
  const organization = decoded.organization === undefined ? null : yield* loadOrganization(root, decoded.organization)
  const policy = yield* Effect.try({
    try: () => resolvePolicy(decoded, source, organization),
    catch: (error) => error instanceof ReviewError ? error : new ReviewError({ code: "config_error", message: String(error) })
  })
  const knowledge = yield* readRepositoryKnowledge(root, decoded.knowledge ?? [])
  return { ...policy, knowledge: [...policy.knowledge, ...knowledge] } satisfies ReviewConfig
})

export const skillsForPath = (file: string, config: ReviewConfig): ReadonlyArray<Skill> => {
  const matches = config.paths.filter(({ pattern }) => picomatch.isMatch(file, pattern, { dot: true }))
  if (matches.length === 0) return config.skills
  return config.skills.filter((skill) => config.requiredSkills.includes(skill) || matches.some((rule) => rule.skills.includes(skill)))
}
