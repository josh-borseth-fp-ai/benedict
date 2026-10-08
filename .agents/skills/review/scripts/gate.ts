import { parse } from "yaml"
import picomatch from "picomatch"

export type Severity = "low" | "medium" | "high" | "critical"

export type Finding = {
  severity: Severity
  skill: string
  file: string
  startLine: number
  endLine: number
  title: string
  confidence: number
}

export type Report = {
  version: 1
  pr: string
  base: string
  head: string
  findings: Finding[]
  dropped: number
  skills: string[]
}

export type StampConfig = {
  enabled: boolean
  team?: string
  channel?: string
  denyPaths: string[]
  maxChangedLines: number
}

export type PullRequest = {
  url: string
  number: number
  state: string
  isDraft: boolean
  headRefOid: string
  baseRefName: string
}

export type ChangedFile = { path: string; lines: number }

export type Facts = {
  report: Report
  config: StampConfig
  pr: PullRequest
  mergeBase: string
  files: ChangedFile[]
  comments: string[]
}

export const CONFIG_FILES = ["review.yaml", "review.yml", "review.json"]

/** A PR that touches these could change the rules it is judged by. */
export const PROTECTED_PATHS = [...CONFIG_FILES, ".agents/skills/review/**"]

export const DEFAULT_MAX_CHANGED_LINES = 400

const SEVERITIES = ["low", "medium", "high", "critical"]
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0

const isLine = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1

const parseFinding = (value: unknown, index: number): Finding => {
  const at = `findings[${index}]`
  if (!isRecord(value)) throw new Error(`${at} is not an object.`)
  const { severity, skill, file, startLine, endLine, title, confidence } = value
  if (typeof severity !== "string" || !SEVERITIES.includes(severity))
    throw new Error(`${at}.severity must be one of ${SEVERITIES.join(", ")}.`)
  if (!isString(skill)) throw new Error(`${at}.skill is missing.`)
  if (!isString(file)) throw new Error(`${at}.file is missing.`)
  if (!isLine(startLine) || !isLine(endLine)) throw new Error(`${at} needs startLine and endLine.`)
  if (!isString(title)) throw new Error(`${at}.title is missing.`)
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1)
    throw new Error(`${at}.confidence must be between 0 and 1.`)
  return { severity: severity as Severity, skill, file, startLine, endLine, title, confidence }
}

/** Parse the report JSON the skill writes. Throws on anything malformed. */
export const parseReport = (text: string): Report => {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new Error("Report is not an object.")
  const { version, pr, base, head, findings, dropped, skills = [] } = value
  if (version !== 1) throw new Error("Report version must be 1.")
  if (!isString(pr)) throw new Error("Report pr is missing.")
  if (typeof base !== "string" || !SHA.test(base)) throw new Error("Report base must be a full commit SHA.")
  if (typeof head !== "string" || !SHA.test(head)) throw new Error("Report head must be a full commit SHA.")
  if (!Array.isArray(findings)) throw new Error("Report findings must be an array.")
  if (!Number.isInteger(dropped) || (dropped as number) < 0) throw new Error("Report dropped must be a count.")
  if (!Array.isArray(skills) || !skills.every(isString)) throw new Error("Report skills must be strings.")
  return { version, pr, base, head, findings: findings.map(parseFinding), dropped: dropped as number, skills }
}

/** Read the `stamp` block from a review config file. YAML parsing also covers JSON. */
export const parseStampConfig = (text: string | undefined): StampConfig => {
  const disabled: StampConfig = { enabled: false, denyPaths: [], maxChangedLines: DEFAULT_MAX_CHANGED_LINES }
  if (text === undefined) return disabled
  const root: unknown = parse(text)
  if (!isRecord(root) || root.stamp === undefined) return disabled
  const stamp = root.stamp
  if (!isRecord(stamp)) throw new Error("stamp must be a mapping.")
  const { enabled = false, team, channel, denyPaths = [], maxChangedLines = DEFAULT_MAX_CHANGED_LINES } = stamp
  if (typeof enabled !== "boolean") throw new Error("stamp.enabled must be true or false.")
  if (team !== undefined && !isString(team)) throw new Error("stamp.team must be a name.")
  if (channel !== undefined && !isString(channel)) throw new Error("stamp.channel must be a name.")
  if (!Array.isArray(denyPaths) || !denyPaths.every(isString)) throw new Error("stamp.denyPaths must be globs.")
  if (!Number.isInteger(maxChangedLines) || (maxChangedLines as number) < 1)
    throw new Error("stamp.maxChangedLines must be a positive number.")
  return { enabled, team, channel, denyPaths, maxChangedLines: maxChangedLines as number }
}

/** Parse `git diff --numstat -z --no-renames`. Binary files count as zero lines. */
export const parseNumstat = (text: string): ChangedFile[] =>
  text
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [added = "-", deleted = "-", ...path] = entry.split("\t")
      const count = (n: string) => (n === "-" ? 0 : Number(n))
      return { path: path.join("\t"), lines: count(added) + count(deleted) }
    })

/** Full-match a repository path glob. `api/**` matches `api/v1/user.ts`; `*.ts` does not match `src/user.ts`. */
export const matchGlob = (pattern: string, path: string): boolean =>
  picomatch.isMatch(path, pattern, { dot: true, strictBrackets: true })

export const marker = (head: string) => `<!-- review-agent-stamp:${head} -->`

const short = (sha: string) => sha.slice(0, 7)

/** Every reason the PR may not be stamped. An empty list means stamp. */
export const evaluate = ({ report, config, pr, mergeBase, files, comments }: Facts): string[] => {
  const reasons: string[] = []
  if (!config.enabled) reasons.push("Stamping is off. Set stamp.enabled: true in review.yaml on the base branch.")
  if (config.enabled && (config.team === undefined || config.channel === undefined))
    reasons.push("Set stamp.team and stamp.channel in review.yaml on the base branch.")
  if (pr.state !== "OPEN") reasons.push(`The PR is ${pr.state.toLowerCase()}, not open.`)
  if (pr.isDraft) reasons.push("The PR is a draft.")
  if (pr.headRefOid !== report.head)
    reasons.push(`The review covered ${short(report.head)}, but the PR head is ${short(pr.headRefOid)}.`)
  if (mergeBase !== report.base)
    reasons.push(`The review started at ${short(report.base)}, but the PR branches from ${short(mergeBase)}.`)
  if (report.findings.length > 0) reasons.push(`The review reported ${report.findings.length} finding(s).`)
  for (const file of files) {
    const pattern = [...PROTECTED_PATHS, ...config.denyPaths].find((glob) => matchGlob(glob, file.path))
    if (pattern !== undefined) reasons.push(`The PR changes ${file.path}, which matches ${pattern}.`)
  }
  const lines = files.reduce((sum, file) => sum + file.lines, 0)
  if (lines > config.maxChangedLines)
    reasons.push(`The PR changes ${lines} lines, over the limit of ${config.maxChangedLines}.`)
  if (comments.some((body) => body.includes(marker(pr.headRefOid))))
    reasons.push(`Review Agent already stamped ${short(pr.headRefOid)}.`)
  return reasons
}

export const teamsMessage = (report: Report, pr: PullRequest) =>
  `stamp ${pr.url} — 🤖 Review Agent: automated review of ${short(report.head)}, 0 findings (not a manual stamp)`

export const prComment = (report: Report) =>
  [
    `🤖 **Review Agent** requested a stamp after an automated review of \`${short(report.head)}\` (\`${short(report.base)}\`…\`${short(report.head)}\`).`,
    "",
    `Findings: 0 · drafts dropped: ${report.dropped}${report.skills.length > 0 ? ` · skills: ${report.skills.join(", ")}` : ""}.`,
    "",
    "This stamp was automated, not a manual review.",
    "",
    marker(report.head),
  ].join("\n")
