import { Effect, FileSystem, Path } from "effect"
import { readCommittedConfig } from "./config.js"
import { binaryPaths, changedLines, Git, parseRawDiff } from "./git.js"
import type { RawChange } from "./git.js"
import { ReviewError, sourceLines } from "./model.js"
import type { ChangedFile, ReviewOptions, Snapshot } from "./model.js"
import { loadOrganization } from "./organization.js"
import { combineSkills, readBuiltinSkills, readCommittedSkills, skillsForPath, summarize } from "./skills.js"

/**
 * Loads the review skills: built-in skills, the organization's latest skills and repository skills committed at the base.
 * A repository skill replaces an organization or built-in skill with the same name, and an organization skill replaces a built-in one.
 * The config and repository skills come from the base, so a change cannot rewrite its own review.
 */
export const loadReviewSkills = Effect.fn("Review.loadSkills")(function*(root: string, base: string) {
  const config = yield* readCommittedConfig(root, base)
  const organization = config.organization === undefined ? null : yield* loadOrganization(root, config.organization)
  const skills = combineSkills(
    yield* readBuiltinSkills(),
    organization?.skills ?? [],
    yield* readCommittedSkills(root, base, "repository")
  )
  return { organization: organization?.organization ?? null, skills }
})

export const collectSnapshot = Effect.fn("Review.collectSnapshot")(function*(options: ReviewOptions) {
  if (options.worktree && options.head !== undefined) {
    return yield* new ReviewError({ code: "range_error", message: "Use --head for a commit review or --worktree for current files; these options cannot be combined." })
  }
  const git = yield* Git
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = (yield* git.run(path.resolve(options.repo), ["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "")
  const baseRef = options.base ?? (options.worktree ? "HEAD" : "HEAD~1")
  const resolve = (ref: string) => git.run(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).pipe(
    Effect.map((value) => value.trim()),
    Effect.mapError(() => new ReviewError({ code: "range_error", message: `Cannot resolve commit ${JSON.stringify(ref)}. Pass an existing --base and --head.` }))
  )
  const base = yield* resolve(baseRef)
  const head = options.worktree ? null : yield* resolve(options.head ?? "HEAD")
  const refs = head === null ? [base] : [base, head]
  const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--ignore-submodules=none"]
  const [raw, numstat] = yield* Effect.all([
    git.run(root, [...diffArgs, "--raw", "--no-abbrev", "-z", ...refs, "--"]),
    git.run(root, [...diffArgs, "--numstat", "-z", ...refs, "--"])
  ], { concurrency: 2 })
  const parsed = yield* Effect.try({
    try: () => ({ changes: parseRawDiff(raw), binaries: binaryPaths(numstat) }),
    catch: (error) => new ReviewError({ code: "git_error", message: String(error) })
  })
  const { organization, skills: loaded } = yield* loadReviewSkills(root, base)
  const skills = loaded.map(summarize)
  const physicalRoot = yield* fs.realPath(root)
  const sources = new Map<string, string>()

  const readWorktree = Effect.fn("Review.readWorktree")(function*(file: string) {
    const absolute = path.join(physicalRoot, file)
    const link = yield* fs.readLink(absolute).pipe(Effect.result)
    if (link._tag === "Success") return null
    const real = yield* fs.realPath(absolute)
    // Exclude symlinks, including directory links, before reading their targets.
    if (real !== absolute) return null
    const info = yield* fs.stat(real)
    if (info.type !== "File") return null
    return yield* fs.readFileString(real)
  })

  const inspect = Effect.fn("Review.inspectFile")(function*(change: RawChange) {
    const reviewable = change.mode === "100644" || change.mode === "100755"
    const content = !reviewable || parsed.binaries.has(change.path) ? null : head === null
      ? yield* readWorktree(change.path)
      : yield* git.run(root, ["cat-file", "blob", change.object])
    const binary = parsed.binaries.has(change.path) || (content?.includes("\0") ?? false)
    const patch = binary ? "" : yield* git.run(root, [
      ...diffArgs, "--unified=0", "--no-color", ...refs, "--",
      ...(change.oldPath === undefined ? [] : [change.oldPath]), change.path
    ])
    if (content !== null && !binary) sources.set(change.path, content)
    return {
      path: change.path,
      ...(change.oldPath === undefined ? {} : { oldPath: change.oldPath }),
      status: change.status,
      binary,
      reviewable: reviewable && content !== null && !binary,
      lineCount: content === null || binary ? 0 : sourceLines(content).length,
      changedLines: changedLines(patch),
      skills: skillsForPath(change.path, skills),
      patch
    } satisfies ChangedFile
  })

  let files: ChangedFile[] = [...yield* Effect.forEach(parsed.changes, inspect, { concurrency: 4 })]
  if (options.worktree) {
    const untracked = (yield* git.run(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)
    const untrackedPaths = new Set(untracked)
    // A staged deletion may have been recreated as an untracked on-disk file.
    files = files.filter((file) => !(file.status === "deleted" && untrackedPaths.has(file.path)))
    const seen = new Set(files.map((file) => file.path))
    const additions = yield* Effect.forEach(untracked.filter((file) => !seen.has(file)), Effect.fn(function*(file: string) {
      const content = yield* readWorktree(file)
      const binary = content?.includes("\0") ?? false
      const lines = content === null || binary ? [] : sourceLines(content)
      if (content !== null && !binary) sources.set(file, content)
      return {
        path: file,
        status: "untracked",
        binary,
        reviewable: content !== null && !binary,
        lineCount: lines.length,
        changedLines: lines.map((_, index) => index + 1),
        skills: skillsForPath(file, skills),
        patch: lines.length === 0 ? "" : `--- /dev/null\n+++ ${JSON.stringify(file)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}\n`).join("")}`
      } satisfies ChangedFile
    }), { concurrency: 4 })
    files.push(...additions)
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return {
    context: {
      formatVersion: 1,
      repository: root,
      range: { base, head, worktree: options.worktree },
      organization,
      skills,
      files
    },
    sources
  } satisfies Snapshot
})
