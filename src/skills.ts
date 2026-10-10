import { fileURLToPath } from "node:url"
import { Effect, FileSystem, Path, Schema } from "effect"
import picomatch from "picomatch"
import { Git } from "./git.js"
import { ReviewError, SkillName, skillsPath } from "./model.js"
import type { ReviewSkill, SkillScope, SkillSummary } from "./model.js"

/** Benedict's own review skills, shipped with the CLI. */
export const builtinSkillsDirectory = fileURLToPath(new URL("../review-skills/", import.meta.url))
const maxSkillBytes = 262144
const isSkillName = Schema.is(SkillName)

const skillFile = /^\.benedict\/skills\/([^/]+)\/SKILL\.md$/

const skillError = (message: string) => new ReviewError({ code: "skill_error", message })
const tryParse = (parse: () => ReviewSkill) => Effect.try({
  try: parse,
  catch: (error) => error instanceof ReviewError ? error : skillError(String(error))
})

interface Field {
  readonly value: string
  readonly block: ReadonlyArray<string>
}

/** Splits YAML frontmatter into top-level fields. Only the keys Benedict reads are interpreted. */
const splitFrontmatter = (text: string, location: string) => {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)
  if (!match) throw skillError(`${location} must start with frontmatter between --- lines.`)
  const fields = new Map<string, Field>()
  const lines = match[1]!.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (line.trim() === "" || line.startsWith("#")) continue
    const field = /^([\w-]+):(?:[ \t]+(.*))?$/.exec(line)
    if (!field) throw skillError(`${location} has unsupported frontmatter: ${JSON.stringify(line)}`)
    const block: string[] = []
    while (index + 1 < lines.length && /^(?:$|\s|- )/.test(lines[index + 1]!)) block.push(lines[++index]!)
    while (block.length > 0 && block.at(-1)!.trim() === "") block.pop()
    fields.set(field[1]!, { value: (field[2] ?? "").trim(), block })
  }
  return { fields, body: text.slice(match[0].length) }
}

const scalar = (value: string, block: ReadonlyArray<string>, location: string): string => {
  if (/^[>|][+-]?$/.test(value)) {
    const lines = block.map((line) => line.trim())
    return (value.startsWith(">") ? lines.filter(Boolean).join(" ") : lines.join("\n")).trim()
  }
  if (block.length > 0) {
    if (/^["']/.test(value)) throw skillError(`${location}: quoted frontmatter values must fit on one line.`)
    return [value, ...block.map((line) => line.trim())].filter(Boolean).join(" ")
  }
  if (value.startsWith("\"")) {
    const quoted = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(value)
    try { return String(JSON.parse(quoted![1]!)) } catch { throw skillError(`${location}: invalid quoted value ${value}.`) }
  }
  if (value.startsWith("'")) {
    const quoted = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(value)
    if (!quoted) throw skillError(`${location}: invalid quoted value ${value}.`)
    return quoted[1]!.replace(/''/g, "'")
  }
  return value.replace(/\s+#.*$/, "")
}

const list = (field: Field, location: string): ReadonlyArray<string> => {
  if (field.value.startsWith("[")) {
    let parsed: unknown
    try { parsed = JSON.parse(field.value) } catch { parsed = undefined }
    if (!Array.isArray(parsed) || field.block.length > 0 || !parsed.every((item) => typeof item === "string")) {
      throw skillError(`${location}: write paths as a JSON-style array of quoted strings or as a YAML list.`)
    }
    return parsed
  }
  if (field.value !== "") throw skillError(`${location}: paths must be a list.`)
  return field.block.filter((line) => line.trim() !== "").map((line) => {
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (!item) throw skillError(`${location}: paths must be a list.`)
    return scalar(item[1]!.trim(), [], location)
  })
}

const validatePattern = (pattern: string, location: string) => {
  if (pattern.trim() === "" || pattern.startsWith("/") || pattern.includes("\\") || pattern.split("/").includes("..")) {
    throw skillError(`${location}: path patterns must be repository-relative with forward slashes: ${JSON.stringify(pattern)}`)
  }
  try { picomatch(pattern, { dot: true, strictBrackets: true }) } catch (error) {
    throw skillError(`${location}: invalid path pattern ${JSON.stringify(pattern)}: ${String(error)}`)
  }
}

/** Parses a SKILL.md: `name` must match its directory, `description` is required and `paths` optionally limits it to matching files. */
export const parseSkill = (text: string, directory: string, scope: SkillScope, location: string): ReviewSkill => {
  if (text.includes("\0") || Buffer.byteLength(text) > maxSkillBytes) throw skillError(`${location} must be text of at most 256 KiB.`)
  const { fields, body } = splitFrontmatter(text.replace(/\r\n/g, "\n"), location)
  const read = (key: string) => {
    const field = fields.get(key)
    return field === undefined ? "" : scalar(field.value, field.block, location)
  }
  const name = read("name")
  if (!isSkillName(name) || name !== directory) {
    throw skillError(`${location}: name must be lowercase letters, digits and hyphens, and match its directory ${JSON.stringify(directory)}.`)
  }
  const description = read("description")
  if (description === "") throw skillError(`${location}: description is required.`)
  const pathsField = fields.get("paths")
  const paths = pathsField === undefined ? undefined : list(pathsField, location)
  if (paths !== undefined) {
    if (paths.length === 0) throw skillError(`${location}: paths cannot be empty; omit it to apply the skill to every file.`)
    for (const pattern of paths) validatePattern(pattern, location)
  }
  return { name, description, scope, ...(paths === undefined ? {} : { paths }), content: body.trim() + "\n" }
}

/** Reads `.benedict/skills/<name>/SKILL.md` from a commit. Git objects are read directly, so links are never followed. */
export const readCommittedSkills = Effect.fn("Skills.readCommitted")(function*(cwd: string, revision: string, scope: SkillScope) {
  const git = yield* Git
  const entries = (yield* git.run(cwd, ["ls-tree", "-r", "-z", "--full-tree", revision, "--", skillsPath])).split("\0").filter(Boolean)
  const skills: ReviewSkill[] = []
  for (const entry of entries) {
    const match = /^(\d{6}) (\w+) ([a-f0-9]+)\t(.*)$/s.exec(entry)
    const file = match?.[4] ?? ""
    const directory = skillFile.exec(file)?.[1]
    if (directory === undefined) continue
    if (match![1] !== "100644" && match![1] !== "100755") return yield* skillError(`${file} must be a regular file at ${revision}.`)
    const text = yield* git.run(cwd, ["cat-file", "blob", match![3]!])
    skills.push(yield* tryParse(() => parseSkill(text, directory, scope, file)))
  }
  return skills
})

export const readBuiltinSkills = Effect.fn("Skills.readBuiltin")(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directories = (yield* fs.readDirectory(builtinSkillsDirectory)).sort()
  return yield* Effect.forEach(directories, (directory) => fs.readFileString(path.join(builtinSkillsDirectory, directory, "SKILL.md")).pipe(
    Effect.flatMap((text) => tryParse(() => parseSkill(text, directory, "built-in", `built-in skill ${directory}`)))
  ))
})

/** Combines scopes from least to most specific. A later scope's skill replaces an earlier skill with the same name. */
export const combineSkills = (...scopes: ReadonlyArray<ReadonlyArray<ReviewSkill>>): ReadonlyArray<ReviewSkill> =>
  [...new Map(scopes.flat().map((skill) => [skill.name, skill])).values()]

export const summarize = ({ content: _, ...summary }: ReviewSkill): SkillSummary => summary

/** Names of the skills that apply to a repository-relative path. */
export const skillsForPath = (file: string, skills: ReadonlyArray<SkillSummary>): ReadonlyArray<string> =>
  skills.filter((skill) => skill.paths === undefined || skill.paths.some((pattern) => picomatch.isMatch(file, pattern, { dot: true }))).map((skill) => skill.name)
