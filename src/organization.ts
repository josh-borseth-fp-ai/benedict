import { createHash, randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { Effect, FileSystem, Path } from "effect"
import { Git } from "./git.js"
import { ReviewError, configPath, skillsPath } from "./model.js"
import type { OrganizationReference, OrganizationRevision } from "./model.js"
import { readCommittedSkills } from "./skills.js"

const organizationError = (message: string) => new ReviewError({ code: "organization_error", message })

export const resolveSource = Effect.fn("Organization.resolveSource")(function*(root: string, organization: OrganizationReference) {
  const path = yield* Path.Path
  const source = organization.source
  if (source.startsWith("-") || /[\r\n\0]/.test(source)) return yield* organizationError("Invalid organization source.")
  if (/^(https|ssh|file):\/\//.test(source)) {
    yield* Effect.try({
      try: () => {
        const url = new URL(source)
        if (url.password || (url.protocol === "https:" && url.username)) throw new Error("Use Git authentication; embedded credentials are not supported.")
      },
      catch: (error) => organizationError(String(error))
    })
    return source
  }
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(source)) return source
  if (source.includes(":") && !path.isAbsolute(source)) {
    return yield* organizationError("Organization sources must be HTTPS, SSH, file URLs, or local repository paths.")
  }
  return path.resolve(root, source)
})

export const cacheDirectory = Effect.fn("Organization.cacheDirectory")(function*(root: string, source: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const base = process.env.BENEDICT_CACHE_DIR ?? path.join(
    process.env.XDG_CACHE_HOME ?? (process.platform === "win32" ? process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local") : path.join(homedir(), ".cache")),
    "benedict"
  )
  const cache = path.resolve(base)
  let ancestor = cache
  const missing: string[] = []
  while (!(yield* fs.exists(ancestor))) {
    missing.unshift(path.basename(ancestor))
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const physicalCache = path.join(yield* fs.realPath(ancestor), ...missing)
  const relative = path.relative(yield* fs.realPath(root), physicalCache)
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return yield* organizationError("The organization cache must be outside the reviewed repository.")
  }
  return path.join(cache, createHash("sha256").update(source).digest("hex"))
})

/** Creates `.benedict/` for CLI-owned state and refuses a symlinked directory. */
export const reviewDirectory = Effect.fn("Organization.reviewDirectory")(function*(root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.join(root, path.dirname(configPath))
  yield* fs.makeDirectory(directory, { recursive: true })
  if ((yield* fs.realPath(directory)) !== path.join(yield* fs.realPath(root), path.dirname(configPath))) {
    return yield* organizationError("The .benedict directory cannot be a symlink.")
  }
  return directory
})

/** Replaces a file atomically through a temporary sibling directory. */
export const writeAtomically = Effect.fn("Organization.writeAtomically")(function*(target: string, text: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* Effect.scoped(Effect.gen(function*() {
    const temporary = yield* fs.makeTempDirectoryScoped({ directory: path.dirname(target), prefix: ".benedict-write-" })
    const file = path.join(temporary, path.basename(target))
    yield* fs.writeFileString(file, text)
    yield* fs.rename(file, target)
  }))
})

const unavailable = (error: ReviewError) => new ReviewError({
  code: "organization_unavailable",
  message: `Cannot fetch organization skills: ${error.message}`
})

/**
 * Fetches the organization's default branch and reads its review skills. Every call fetches, so reviews always use the
 * latest organization skills; the cache only saves transfer. Organization code is never checked out.
 */
export const loadOrganization = Effect.fn("Organization.load")(function*(root: string, organization: OrganizationReference) {
  const git = yield* Git
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const source = yield* resolveSource(root, organization)
  const cache = yield* cacheDirectory(root, source)
  const parent = path.dirname(cache)
  if (!(yield* fs.exists(cache))) {
    yield* fs.makeDirectory(parent, { recursive: true })
    yield* Effect.scoped(Effect.gen(function*() {
      const staging = yield* fs.makeTempDirectoryScoped({ directory: parent, prefix: ".clone-" })
      const repository = path.join(staging, "repository.git")
      yield* git.run(parent, ["-c", "protocol.ext.allow=never", "clone", "--bare", "--no-hardlinks", "--", source, repository], { timeout: "5 minutes" }).pipe(Effect.mapError(unavailable))
      // Another review may have completed while the clone was running.
      if (!(yield* fs.exists(cache))) yield* fs.rename(repository, cache).pipe(Effect.catch((error) => Effect.gen(function*() {
        // A competing clone can win between exists and rename; validate it below.
        if (!(yield* fs.exists(cache))) return yield* Effect.fail(error)
      })))
    }))
  }
  const bare = (yield* git.run(cache, ["rev-parse", "--is-bare-repository"])).trim()
  if (bare !== "true") return yield* organizationError("The organization cache is not a bare Git repository.")
  // Each fetch owns a ref so concurrent reviews cannot race on FETCH_HEAD.
  return yield* Effect.scoped(Effect.gen(function*() {
    const fetched = `refs/benedict-fetch/${randomUUID()}`
    yield* Effect.addFinalizer(() => git.run(cache, ["update-ref", "-d", fetched]).pipe(Effect.catch(() => Effect.succeed(""))))
    yield* git.run(cache, ["-c", "protocol.ext.allow=never", "fetch", "--no-tags", "--no-write-fetch-head", "--", source, `HEAD:${fetched}`], { timeout: "5 minutes" }).pipe(Effect.mapError(unavailable))
    const revision = (yield* git.run(cache, ["rev-parse", "--verify", `${fetched}^{commit}`])).trim()
    const skills = yield* readCommittedSkills(cache, revision, "organization")
    if (skills.length === 0) return yield* organizationError(`The organization repository has no skills under ${skillsPath} at ${revision}.`)
    return { organization: { source, revision } satisfies OrganizationRevision, skills }
  }))
})
