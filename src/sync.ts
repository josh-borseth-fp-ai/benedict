import { randomUUID } from "node:crypto"
import { Effect, FileSystem, Path } from "effect"
import { readRepositoryConfig } from "./config.js"
import { Git } from "./git.js"
import { cacheDirectory, readLock, readOrganizationBundle, readRepositoryKnowledge, resolveOrganization, writeLock } from "./knowledge.js"
import { ReviewError } from "./model.js"
import type { ConfigFile } from "./model.js"
import { resolvePolicy } from "./policy.js"

export const repositoryRoot = Effect.fn("Review.repositoryRoot")(function*(directory: string) {
  const git = yield* Git
  const path = yield* Path.Path
  return (yield* git.run(path.resolve(directory), ["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "")
})

/** Fetching is explicit. This prepares a validated bundle without changing repo files. */
export const prepareOrganization = Effect.fn("Knowledge.prepare")(function*(root: string, decoded: ConfigFile, update: boolean) {
  if (!decoded.organization) {
    return yield* new ReviewError({ code: "knowledge_error", message: "No organization configured. Add organization.source to review.yaml or run review setup --organization <Git URL> inside the repository." })
  }
  const git = yield* Git
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const resolved = yield* resolveOrganization(root, decoded.organization)
  const existing = yield* readLock(root)
  if (existing && !update && (existing.source !== resolved.source || existing.ref !== resolved.ref)) {
    return yield* new ReviewError({ code: "knowledge_unavailable", message: "Organization source/ref changed. Run review sync --update to review and record the new revision." })
  }
  // Validate local knowledge before fetching or writing a lock.
  yield* readRepositoryKnowledge(root, decoded.knowledge ?? [])
  const cache = yield* cacheDirectory(root, resolved.source)
  const parent = path.dirname(cache)
  if (!(yield* fs.exists(cache))) {
    yield* fs.makeDirectory(parent, { recursive: true })
    yield* Effect.scoped(Effect.gen(function*() {
      const staging = yield* fs.makeTempDirectoryScoped({ directory: parent, prefix: ".clone-" })
      const repository = path.join(staging, "repository.git")
      yield* git.run(parent, ["-c", "protocol.ext.allow=never", "clone", "--bare", "--no-hardlinks", "--", resolved.source, repository])
      // Another sync may have completed while the clone was running.
      if (!(yield* fs.exists(cache))) yield* fs.rename(repository, cache).pipe(Effect.catch((error) => Effect.gen(function*() {
        // A competing clone can win between exists and rename; validate it below.
        if (!(yield* fs.exists(cache))) return yield* Effect.fail(error)
      })))
    }))
  }
  const bare = (yield* git.run(cache, ["rev-parse", "--is-bare-repository"])).trim()
  if (bare !== "true") return yield* new ReviewError({ code: "knowledge_error", message: "Knowledge cache is not a bare Git repository." })
  let revision: string
  if (existing && !update) {
    revision = existing.revision
    const present = yield* git.run(cache, ["cat-file", "-e", `${revision}^{commit}`]).pipe(Effect.result)
    if (present._tag === "Failure") {
      yield* git.run(cache, ["-c", "protocol.ext.allow=never", "fetch", "--no-tags", "--", resolved.source, revision])
    }
  } else {
    // Each sync owns a ref so concurrent repositories cannot race on FETCH_HEAD.
    revision = yield* Effect.scoped(Effect.gen(function*() {
      const temporaryRef = `refs/review-sync/${randomUUID()}`
      yield* Effect.addFinalizer(() => git.run(cache, ["update-ref", "-d", temporaryRef]).pipe(Effect.catch(() => Effect.succeed(""))))
      yield* git.run(cache, ["-c", "protocol.ext.allow=never", "fetch", "--no-tags", "--no-write-fetch-head", "--", resolved.source, `${resolved.ref}:${temporaryRef}`])
      return (yield* git.run(cache, ["rev-parse", "--verify", `${temporaryRef}^{commit}`])).trim()
    }))
  }
  const lock = { version: 1 as const, ...resolved, revision }
  const bundle = yield* readOrganizationBundle(cache, lock)
  yield* Effect.try({
    try: () => resolvePolicy(decoded, null, bundle),
    catch: (error) => error instanceof ReviewError ? error : new ReviewError({ code: "config_error", message: String(error) })
  })
  return bundle
})

export const syncOrganization = Effect.fn("Knowledge.sync")(function*(root: string, config: string | undefined, update: boolean) {
  const { decoded } = yield* readRepositoryConfig(root, config)
  const bundle = yield* prepareOrganization(root, decoded, update)
  const previous = yield* readLock(root)
  if (JSON.stringify(previous) !== JSON.stringify(bundle.lock)) yield* writeLock(root, bundle.lock)
  return {
    organization: bundle.lock,
    knowledgeFiles: bundle.knowledge.map((document) => document.path),
    lockChanged: JSON.stringify(previous) !== JSON.stringify(bundle.lock)
  }
})
