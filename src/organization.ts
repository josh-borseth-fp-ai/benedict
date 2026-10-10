import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { Effect, FileSystem, Path, Schema } from "effect"
import { parseJson } from "./config.js"
import { Git, readCommittedFile } from "./git.js"
import { OrganizationLock, ReviewError, lockPath, skillsPath } from "./model.js"
import type { OrganizationReference } from "./model.js"
import { readCommittedSkills } from "./skills.js"

const organizationError = (message: string) => new ReviewError({ code: "organization_error", message })

export const resolveOrganization = Effect.fn("Organization.resolveSource")(function*(root: string, organization: OrganizationReference) {
  const path = yield* Path.Path
  let source = organization.source
  const ref = organization.ref ?? "HEAD"
  if (source.startsWith("-") || /[\r\n\0]/.test(source) || ref.startsWith("-") || /[\s\0]/.test(ref) || [":", "*", "?", "[", "]", "\\", "~", "^"].some((character) => ref.includes(character))) {
    return yield* organizationError("Invalid organization source or ref.")
  }
  if (/^(https|ssh|file):\/\//.test(source)) {
    yield* Effect.try({
      try: () => {
        const url = new URL(source)
        if (url.password || (url.protocol === "https:" && url.username)) throw new Error("Use Git authentication; embedded credentials are not supported.")
      },
      catch: (error) => organizationError(String(error))
    })
  } else if (!/^[\w.-]+@[\w.-]+:[^\s]+$/.test(source)) {
    if (source.includes(":") && !path.isAbsolute(source)) {
      return yield* organizationError("Organization sources must be HTTPS, SSH, file URLs, or local repository paths.")
    }
    source = path.resolve(root, source)
  }
  return { source, ref }
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

const decodeLock = Effect.fn("Organization.decodeLock")(function*(text: string) {
  return yield* Schema.decodeUnknownEffect(OrganizationLock, { onExcessProperty: "error" })(yield* parseJson(text, lockPath, "organization_error")).pipe(
    Effect.mapError((error) => organizationError(`Invalid ${lockPath}: ${error.message}`))
  )
})

/** The working-tree lock, which setup and sync write. */
export const readLock = Effect.fn("Organization.readLock")(function*(root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(root, lockPath)
  if (!(yield* fs.exists(file))) return null
  if ((yield* fs.realPath(file)) !== path.join(yield* fs.realPath(root), lockPath)) {
    return yield* organizationError("The organization lock cannot use symlinks.")
  }
  return yield* decodeLock(yield* fs.readFileString(file))
})

/** Creates `.benedict/` for CLI-owned state and refuses a symlinked directory. */
export const reviewDirectory = Effect.fn("Organization.reviewDirectory")(function*(root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.join(root, path.dirname(lockPath))
  yield* fs.makeDirectory(directory, { recursive: true })
  if ((yield* fs.realPath(directory)) !== path.join(yield* fs.realPath(root), path.dirname(lockPath))) {
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

export const writeLock = Effect.fn("Organization.writeLock")(function*(root: string, lock: OrganizationLock) {
  const path = yield* Path.Path
  yield* reviewDirectory(root)
  yield* writeAtomically(path.join(root, lockPath), JSON.stringify(lock, null, 2) + "\n")
})

/** Reads the organization's review skills at its locked revision. Organization code is never checked out. */
export const readOrganizationSkills = Effect.fn("Organization.readSkills")(function*(cache: string, lock: OrganizationLock) {
  const git = yield* Git
  yield* git.run(cache, ["cat-file", "-e", `${lock.revision}^{commit}`]).pipe(Effect.mapError(() => new ReviewError({
    code: "organization_unavailable", message: "The locked organization revision is unavailable. Run benedict sync to populate the cache."
  })))
  const skills = yield* readCommittedSkills(cache, lock.revision, "organization")
  if (skills.length === 0) return yield* organizationError(`The organization repository has no skills under ${skillsPath} at ${lock.revision}.`)
  return skills
})

/** Loads the organization selected and locked at a review's base. Review commands never fetch. */
export const loadOrganization = Effect.fn("Organization.load")(function*(root: string, base: string, organization: OrganizationReference) {
  const fs = yield* FileSystem.FileSystem
  const resolved = yield* resolveOrganization(root, organization)
  const text = yield* readCommittedFile(root, base, lockPath, "organization_error")
  const lock = text === null ? null : yield* decodeLock(text)
  if (!lock || lock.source !== resolved.source || lock.ref !== resolved.ref) {
    return yield* new ReviewError({ code: "organization_unavailable", message: `The reviewed base has no matching ${lockPath}. Run benedict sync (or benedict sync --update after changing the source or ref) and commit the lock.` })
  }
  const cache = yield* cacheDirectory(root, lock.source)
  if (!(yield* fs.exists(cache))) {
    return yield* new ReviewError({ code: "organization_unavailable", message: "Organization skills are not cached. Run benedict sync before reviewing." })
  }
  return { lock, skills: yield* readOrganizationSkills(cache, lock) }
})
