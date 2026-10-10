import { randomUUID } from "node:crypto"
import { Effect, FileSystem, Path } from "effect"
import { readRepositoryConfig } from "./config.js"
import { Git } from "./git.js"
import { ReviewError, configPath } from "./model.js"
import type { ConfigFile } from "./model.js"
import { cacheDirectory, readLock, readOrganizationSkills, resolveOrganization, writeLock } from "./organization.js"
import { combineSkills, readBuiltinSkills } from "./skills.js"

export const repositoryRoot = Effect.fn("Review.repositoryRoot")(function*(directory: string) {
  const git = yield* Git
  const path = yield* Path.Path
  return (yield* git.run(path.resolve(directory), ["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "")
})

/** Fetching is explicit. This prepares validated organization skills without changing repo files. */
export const prepareOrganization = Effect.fn("Organization.prepare")(function*(root: string, decoded: ConfigFile, update: boolean) {
  if (!decoded.organization) {
    return yield* new ReviewError({ code: "organization_error", message: `No organization configured. Add organization.source to ${configPath} or run benedict setup --organization <Git URL> inside the repository.` })
  }
  const git = yield* Git
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const resolved = yield* resolveOrganization(root, decoded.organization)
  const existing = yield* readLock(root)
  if (existing && !update && (existing.source !== resolved.source || existing.ref !== resolved.ref)) {
    return yield* new ReviewError({ code: "organization_unavailable", message: "Organization source/ref changed. Run benedict sync --update to review and record the new revision." })
  }
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
  if (bare !== "true") return yield* new ReviewError({ code: "organization_error", message: "The organization cache is not a bare Git repository." })
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
      const temporaryRef = `refs/benedict-sync/${randomUUID()}`
      yield* Effect.addFinalizer(() => git.run(cache, ["update-ref", "-d", temporaryRef]).pipe(Effect.catch(() => Effect.succeed(""))))
      yield* git.run(cache, ["-c", "protocol.ext.allow=never", "fetch", "--no-tags", "--no-write-fetch-head", "--", resolved.source, `${resolved.ref}:${temporaryRef}`])
      return (yield* git.run(cache, ["rev-parse", "--verify", `${temporaryRef}^{commit}`])).trim()
    }))
  }
  const lock = { version: 1 as const, ...resolved, revision }
  const skills = yield* readOrganizationSkills(cache, lock)
  yield* combineSkills(yield* readBuiltinSkills(), skills)
  return { lock, skills }
})

export const syncOrganization = Effect.fn("Organization.sync")(function*(root: string, update: boolean) {
  const { decoded } = yield* readRepositoryConfig(root)
  const { lock, skills } = yield* prepareOrganization(root, decoded, update)
  const previous = yield* readLock(root)
  const lockChanged = JSON.stringify(previous) !== JSON.stringify(lock)
  if (lockChanged) yield* writeLock(root, lock)
  return { organization: lock, skills: skills.map((skill) => skill.name), lockChanged }
})
