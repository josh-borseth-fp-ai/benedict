import { Effect, FileSystem, Path, Schema } from "effect"
import picomatch from "picomatch"
import { ConfigFile, ReviewError, configPath } from "./model.js"
import type { ReviewConfig, Skill } from "./model.js"
import { loadOrganization, readRepositoryKnowledge } from "./knowledge.js"
import { parseJson, resolvePolicy } from "./policy.js"

const emptyConfig: ConfigFile = {}

export const readRepositoryConfig = Effect.fn("Review.readConfig")(function*(root: string, explicit?: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.resolve(root, explicit ?? configPath)
  if (!(yield* fs.exists(file))) {
    if (explicit !== undefined) return yield* new ReviewError({ code: "config_error", message: `Config does not exist: ${file}` })
    return { source: null, decoded: emptyConfig }
  }
  const parsed = yield* parseJson(yield* fs.readFileString(file), file)
  const decoded = yield* Schema.decodeUnknownEffect(ConfigFile, { onExcessProperty: "error" })(parsed).pipe(
    Effect.mapError((error) => new ReviewError({ code: "config_error", message: `Invalid config ${file}: ${error.message}` }))
  )
  return { source: file, decoded }
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
