import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { Effect, FileSystem, Path, Schema } from "effect"
import { Git } from "./git.js"
import { KnowledgeLock, OrganizationManifest, ReviewError } from "./model.js"
import type { KnowledgeDocument, OrganizationBundle, OrganizationReference } from "./model.js"
import { parseConfig, relativeDocumentPath } from "./policy.js"

export const lockRelativePath = ".review/knowledge.lock.json"
const configNames = ["review.yaml", "review.yml", "review.json"]
const knowledgeFailure = (error: unknown) => error instanceof ReviewError ? error : new ReviewError({ code: "knowledge_error", message: String(error) })

export const resolveOrganization = Effect.fn("Knowledge.resolveSource")(function*(root: string, organization: OrganizationReference) {
  const path = yield* Path.Path
  let source = organization.source
  const ref = organization.ref ?? "HEAD"
  if (source.startsWith("-") || /[\r\n\0]/.test(source) || ref.startsWith("-") || /[\s\0]/.test(ref) || [":", "*", "?", "[", "]", "\\", "~", "^"].some((character) => ref.includes(character))) {
    return yield* new ReviewError({ code: "knowledge_error", message: "Invalid organization source or ref." })
  }
  if (/^(https|ssh|file):\/\//.test(source)) {
    yield* Effect.try({
      try: () => {
        const url = new URL(source)
        if (url.password || (url.protocol === "https:" && url.username)) throw new Error("Use Git authentication; embedded credentials are not supported.")
      },
      catch: (error) => new ReviewError({ code: "knowledge_error", message: String(error) })
    })
  } else if (!/^[\w.-]+@[\w.-]+:[^\s]+$/.test(source)) {
    if (source.includes(":") && !path.isAbsolute(source)) {
      return yield* new ReviewError({ code: "knowledge_error", message: "Organization sources must be HTTPS, SSH, file URLs, or local repository paths." })
    }
    source = path.resolve(root, source)
  }
  return { source, ref }
})

export const cacheDirectory = Effect.fn("Knowledge.cacheDirectory")(function*(root: string, source: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const base = process.env.REVIEW_CACHE_DIR ?? path.join(
    process.env.XDG_CACHE_HOME ?? (process.platform === "win32" ? process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local") : path.join(homedir(), ".cache")),
    "review"
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
    return yield* new ReviewError({ code: "knowledge_error", message: "The knowledge cache must be outside the reviewed repository." })
  }
  return path.join(cache, createHash("sha256").update(source).digest("hex"))
})

export const readLock = Effect.fn("Knowledge.readLock")(function*(root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(root, lockRelativePath)
  if (!(yield* fs.exists(file))) return null
  const realRoot = yield* fs.realPath(root)
  const realFile = yield* fs.realPath(file)
  if (realFile !== path.join(realRoot, lockRelativePath)) {
    return yield* new ReviewError({ code: "knowledge_error", message: "Knowledge lock files cannot use symlinks." })
  }
  const text = yield* fs.readFileString(file)
  const parsed = yield* parseConfig(text, file)
  return yield* Schema.decodeUnknownEffect(KnowledgeLock, { onExcessProperty: "error" })(parsed).pipe(Effect.mapError(knowledgeFailure))
})

export const writeLock = Effect.fn("Knowledge.writeLock")(function*(root: string, lock: KnowledgeLock) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.join(root, ".review")
  yield* fs.makeDirectory(directory, { recursive: true })
  if ((yield* fs.realPath(directory)) !== path.join(yield* fs.realPath(root), ".review")) {
    return yield* new ReviewError({ code: "knowledge_error", message: "The .review directory cannot be a symlink." })
  }
  yield* Effect.scoped(Effect.gen(function*() {
    const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".lock-" })
    const file = path.join(temporary, "knowledge.lock.json")
    yield* fs.writeFileString(file, JSON.stringify(lock, null, 2) + "\n")
    yield* fs.rename(file, path.join(root, lockRelativePath))
  }))
})

const validateContent = (content: string, file: string): string => {
  if (content.includes("\0") || Buffer.byteLength(content) > 262144) {
    throw new ReviewError({ code: "knowledge_error", message: `Knowledge must be text of at most 256 KiB: ${file}` })
  }
  return content
}

export const readRepositoryKnowledge = Effect.fn("Knowledge.readRepository")(function*(root: string, documents: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const physical = yield* fs.realPath(root)
  return yield* Effect.forEach([...new Set(documents)], Effect.fn(function*(name: string) {
    const file = yield* Effect.try({ try: () => relativeDocumentPath(name), catch: knowledgeFailure })
    const absolute = path.join(physical, file)
    if ((yield* fs.realPath(absolute)) !== absolute) {
      return yield* new ReviewError({ code: "knowledge_error", message: `Knowledge cannot use symlinks: ${file}` })
    }
    const content = yield* fs.readFileString(absolute)
    yield* Effect.try({ try: () => validateContent(content, file), catch: knowledgeFailure })
    return { scope: "repository", path: file, content } satisfies KnowledgeDocument
  }), { concurrency: 4 })
})

export const readOrganizationBundle = Effect.fn("Knowledge.readOrganization")(function*(cache: string, lock: KnowledgeLock) {
  const git = yield* Git
  const readBlob = Effect.fn(function*(file: string, required = true) {
    const entry = yield* git.run(cache, ["ls-tree", "-z", lock.revision, "--", file])
    if (entry === "" && !required) return null
    const match = /^(100644|100755) blob ([a-f0-9]+)\t[^\0]+\0$/.exec(entry)
    if (!match) return yield* new ReviewError({ code: "knowledge_error", message: `Organization knowledge must be a regular file at ${lock.revision}: ${file}` })
    return yield* git.run(cache, ["cat-file", "blob", match[2]!])
  })
  // Reading an exact commit works offline and never checks out organization code.
  yield* git.run(cache, ["cat-file", "-e", `${lock.revision}^{commit}`]).pipe(Effect.mapError(() => new ReviewError({
    code: "knowledge_unavailable", message: "The locked organization revision is unavailable. Run review sync to populate the cache."
  })))
  const manifests = yield* Effect.forEach(configNames, Effect.fn(function*(name) {
    const text = yield* readBlob(name, false)
    return { name, text }
  }))
  const present = manifests.filter((candidate) => candidate.text !== null)
  if (present.length !== 1) {
    return yield* new ReviewError({ code: "knowledge_error", message: "Organization repository must contain exactly one review.yaml, review.yml, or review.json manifest." })
  }
  const selected = present[0]!
  const parsed = yield* parseConfig(selected.text!, selected.name)
  const manifest = yield* Schema.decodeUnknownEffect(OrganizationManifest, { onExcessProperty: "error" })(parsed).pipe(Effect.mapError(knowledgeFailure))
  const knowledge = yield* Effect.forEach([...new Set(manifest.knowledge ?? [])], Effect.fn(function*(name) {
    const file = yield* Effect.try({ try: () => relativeDocumentPath(name), catch: knowledgeFailure })
    const content = (yield* readBlob(file))!
    yield* Effect.try({ try: () => validateContent(content, file), catch: knowledgeFailure })
    return { scope: "organization", path: file, content } satisfies KnowledgeDocument
  }))
  return { lock, manifest, knowledge } satisfies OrganizationBundle
})

export const loadOrganization = Effect.fn("Knowledge.loadLocked")(function*(root: string, organization: OrganizationReference) {
  const fs = yield* FileSystem.FileSystem
  const resolved = yield* resolveOrganization(root, organization)
  const lock = yield* readLock(root)
  if (!lock || lock.source !== resolved.source || lock.ref !== resolved.ref) {
    return yield* new ReviewError({ code: "knowledge_unavailable", message: "Organization knowledge has no matching lock. Run review sync (or review sync --update after changing the source/ref), then commit .review/knowledge.lock.json." })
  }
  const cache = yield* cacheDirectory(root, lock.source)
  if (!(yield* fs.exists(cache))) {
    return yield* new ReviewError({ code: "knowledge_unavailable", message: "Organization knowledge is not cached. Run review sync before reviewing." })
  }
  return yield* readOrganizationBundle(cache, lock)
})
