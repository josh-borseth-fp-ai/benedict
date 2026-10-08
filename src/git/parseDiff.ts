import { FileDiff } from "../domain/Model.js"

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

const stripGitPrefix = (path: string): string => {
  if (path === "/dev/null") return path
  const quoted = path.startsWith("\"") && path.endsWith("\"") ? path.slice(1, -1) : path
  if (quoted.startsWith("a/") || quoted.startsWith("b/")) return quoted.slice(2)
  return quoted
}

interface PendingFile {
  path: string
  oldPath?: string
  added: boolean
  deleted: boolean
  renamed: boolean
  binary: boolean
  touched: Set<number>
  lines: Array<string>
}

const finish = (pending: PendingFile | undefined, into: Array<FileDiff>): void => {
  if (pending === undefined) return
  const status = pending.added
    ? "added"
    : pending.deleted
    ? "deleted"
    : pending.renamed
    ? "renamed"
    : "modified"
  const patch = pending.lines.join("\n")
  into.push(new FileDiff({
    path: pending.path,
    ...(pending.oldPath === undefined ? {} : { oldPath: pending.oldPath }),
    status,
    binary: pending.binary,
    touchedLines: [...pending.touched].sort((a, b) => a - b),
    patch
  }))
}

/** Parse `git diff` unified output into per-file patches and touched new-file lines. */
export const parseUnifiedDiff = (diff: string): ReadonlyArray<FileDiff> => {
  const files: Array<FileDiff> = []
  let pending: PendingFile | undefined
  let newLine = 0
  let inHunk = false

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      finish(pending, files)
      pending = undefined
      inHunk = false
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      const path = match?.[2] ?? "unknown"
      pending = {
        path,
        added: false,
        deleted: false,
        renamed: false,
        binary: false,
        touched: new Set(),
        lines: [line]
      }
      continue
    }
    if (pending === undefined) continue
    pending.lines.push(line)

    if (line.startsWith("rename from ")) {
      pending.renamed = true
      pending.oldPath = line.slice("rename from ".length)
      continue
    }
    if (line.startsWith("rename to ")) {
      pending.path = line.slice("rename to ".length)
      continue
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      pending.binary = true
      inHunk = false
      continue
    }
    if (line.startsWith("--- ")) {
      const oldPath = stripGitPrefix(line.slice(4).trim())
      if (oldPath === "/dev/null") pending.added = true
      else pending.oldPath = oldPath
      continue
    }
    if (line.startsWith("+++ ")) {
      const next = stripGitPrefix(line.slice(4).trim())
      if (next === "/dev/null") pending.deleted = true
      else pending.path = next
      continue
    }

    const hunk = hunkHeader.exec(line)
    if (hunk !== null) {
      inHunk = true
      newLine = Number(hunk[3])
      const newCount = hunk[4] === undefined ? 1 : Number(hunk[4])
      if (newCount === 0 && newLine > 0) pending.touched.add(newLine)
      continue
    }
    if (!inHunk) continue
    if (line.startsWith("\\")) continue
    if (line.startsWith("+")) {
      pending.touched.add(newLine)
      newLine += 1
      continue
    }
    if (line.startsWith("-")) continue
    if (line.startsWith(" ")) {
      pending.touched.add(newLine)
      newLine += 1
    }
  }

  finish(pending, files)
  return files
}

export const capText = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`

export const compactDiff = (files: ReadonlyArray<FileDiff>, maxChars: number): string => {
  const parts: Array<string> = []
  let used = 0
  for (const file of files) {
    const header = `## ${file.status} ${file.path}${file.binary ? " (binary)" : ""}`
    const body = file.binary ? header : `${header}\n${file.patch}`
    if (used + body.length > maxChars) {
      parts.push(`${header}\n…[patch omitted]`)
      break
    }
    parts.push(body)
    used += body.length
  }
  return parts.join("\n\n")
}
