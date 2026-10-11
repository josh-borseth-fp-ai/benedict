import { Effect, FileSystem, Path, Schema } from "effect"
import { readCommittedFile } from "./git.js"
import { ConfigFile, ReviewError, configPath } from "./model.js"

export const parseJson = (text: string, filename: string, code = "config_error") => Effect.try({
  try: () => JSON.parse(text) as unknown,
  catch: (error) => new ReviewError({ code, message: `Invalid JSON in ${filename}: ${String(error)}` })
})

const decodeConfig = Effect.fn("Review.decodeConfig")(function*(text: string, file: string) {
  return yield* Schema.decodeUnknownEffect(ConfigFile, { onExcessProperty: "error" })(yield* parseJson(text, file)).pipe(
    Effect.mapError((error) => new ReviewError({ code: "config_error", message: `Invalid config ${file}: ${error.message}` }))
  )
})

/** The working-tree config, which setup edits. */
export const readRepositoryConfig = Effect.fn("Review.readConfig")(function*(root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(root, configPath)
  if (!(yield* fs.exists(file))) return { source: null, decoded: {} as ConfigFile }
  return { source: file, decoded: yield* decodeConfig(yield* fs.readFileString(file), file) }
})

/** The config committed at a review's base, so a change cannot select the policy it is reviewed under. */
export const readCommittedConfig = Effect.fn("Review.readCommittedConfig")(function*(root: string, revision: string) {
  const text = yield* readCommittedFile(root, revision, configPath, "config_error")
  return text === null ? {} as ConfigFile : yield* decodeConfig(text, configPath)
})
