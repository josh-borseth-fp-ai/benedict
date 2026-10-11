import { Context, Duration, Effect, Layer, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ReviewError } from "./model.js"

export class Git extends Context.Service<Git, {
  readonly run: (cwd: string, args: ReadonlyArray<string>, options?: { readonly timeout?: Duration.Input }) => Effect.Effect<string, ReviewError>
}>()("benedict/Git") {
  static readonly layer = Layer.effect(Git, Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const run = Effect.fn("Git.run")(function*(cwd: string, args: ReadonlyArray<string>, options?: { readonly timeout?: Duration.Input }) {
      const command = ChildProcess.make("git", ["--no-pager", "--literal-pathspecs", ...args], {
        cwd,
        env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
        extendEnv: true
      })
      const result = yield* Effect.scoped(Effect.gen(function*() {
        const handle = yield* spawner.spawn(command)
        const [stdout, stderr, exitCode] = yield* Effect.all([
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode
        ], { concurrency: 3 })
        return { stdout, stderr, exitCode: Number(exitCode) }
      })).pipe(
        Effect.timeout(options?.timeout ?? "30 seconds"),
        Effect.mapError((error) => new ReviewError({
          code: "git_error",
          message: `Cannot run git ${args[0]}: ${String(error)}`
        }))
      )
      if (result.exitCode !== 0) {
        return yield* new ReviewError({
          code: "git_error",
          message: `git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`
        })
      }
      return result.stdout
    })
    return Git.of({ run })
  }))
}

export const repositoryRoot = Effect.fn("Git.repositoryRoot")(function*(directory: string) {
  const git = yield* Git
  const path = yield* Path.Path
  return (yield* git.run(path.resolve(directory), ["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "")
})

export interface RawChange {
  readonly path: string
  readonly oldPath?: string
  readonly mode: string
  readonly object: string
  readonly status: "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed"
}

/** NUL-delimited records preserve spaces, tabs, newlines and Git-quoted names. */
export const parseRawDiff = (raw: string): ReadonlyArray<RawChange> => {
  const tokens = raw.split("\0")
  const changes: RawChange[] = []
  for (let i = 0; i < tokens.length - 1;) {
    const header = tokens[i++]!
    const match = /^:\d{6} (\d{6}) [a-f0-9]+ ([a-f0-9]+) ([ACDMRT])\d*$/.exec(header)
    if (!match) throw new Error("Unexpected Git raw diff record")
    const firstPath = tokens[i++]
    if (!firstPath) throw new Error("Missing Git diff path")
    const kind = match[3]!
    const renamed = kind === "R" || kind === "C"
    const filePath = renamed ? tokens[i++] : firstPath
    if (!filePath) throw new Error("Missing Git destination path")
    const status = { A: "added", C: "copied", D: "deleted", M: "modified", R: "renamed", T: "type-changed" } as const
    changes.push({
      path: filePath,
      ...(renamed ? { oldPath: firstPath } : {}),
      mode: match[1]!,
      object: match[2]!,
      status: status[kind as keyof typeof status]
    })
  }
  return changes
}

export const binaryPaths = (numstat: string): ReadonlySet<string> => {
  const tokens = numstat.split("\0")
  const paths = new Set<string>()
  for (let i = 0; i < tokens.length - 1;) {
    const token = tokens[i++]!
    const match = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/.exec(token)
    if (!match) throw new Error("Unexpected Git numstat record")
    let filePath = match[3]!
    if (filePath === "") {
      i++ // old path in a rename/copy record
      filePath = tokens[i++]!
    }
    if (match[1] === "-" || match[2] === "-") paths.add(filePath)
  }
  return paths
}

export const changedLines = (patch: string): ReadonlyArray<number> => {
  const lines: number[] = []
  for (const line of patch.split("\n")) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!match) continue
    const start = Number(match[1])
    const count = match[2] === undefined ? 1 : Number(match[2])
    for (let i = start; i < start + count; i++) lines.push(i)
  }
  return [...new Set(lines)].sort((a, b) => a - b)
}

/** Reads a regular file from a commit without checking it out. Absent files return null; links and directories fail. */
export const readCommittedFile = Effect.fn("Git.readCommittedFile")(function*(cwd: string, revision: string, file: string, code: string) {
  const git = yield* Git
  const entry = yield* git.run(cwd, ["ls-tree", "-z", "--full-tree", revision, "--", file])
  if (entry === "") return null
  const match = /^(?:100644|100755) blob ([a-f0-9]+)\t[^\0]+\0$/.exec(entry)
  if (!match) return yield* new ReviewError({ code, message: `${file} must be a regular file at ${revision}.` })
  return yield* git.run(cwd, ["cat-file", "blob", match[1]!])
})
