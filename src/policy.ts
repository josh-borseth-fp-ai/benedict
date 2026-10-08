import { Effect } from "effect"
import picomatch from "picomatch"
import { parseDocument } from "yaml"
import { ReviewError } from "./model.js"
import type { ConfigFile, OrganizationBundle, ReviewConfig, Severity, Skill } from "./model.js"

const defaultRules = [
  "Do not report style-only issues.",
  "Only report a real defect or a meaningful risk.",
  "Prefer evidence from the repository over assumptions."
]
const ranks: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 }

export const parseConfig = (text: string, filename: string) => Effect.try({
  try: () => {
    if (filename.endsWith(".json")) return JSON.parse(text) as unknown
    const document = parseDocument(text, { uniqueKeys: true })
    if (document.errors.length > 0) throw new Error(document.errors.map((e) => e.message).join("; "))
    return document.toJS({ maxAliasCount: 50 }) as unknown
  },
  catch: (error) => new ReviewError({ code: "config_error", message: `Invalid config ${filename}: ${String(error)}` })
})

export const relativeDocumentPath = (file: string): string => {
  if (!file.endsWith(".md") || file.startsWith("/") || file.includes("\\") ||
    file.split("/").some((part) => part === ".." || part === "." || part === "") || /^[a-z]:/i.test(file)) {
    throw new ReviewError({ code: "knowledge_error", message: `Knowledge must name a repository-relative Markdown file: ${JSON.stringify(file)}` })
  }
  return file
}

export const resolvePolicy = (local: ConfigFile, source: string | null, org: OrganizationBundle | null): ReviewConfig => {
  const defaults = org?.manifest.defaults
  const required = org?.manifest.required ?? {}
  const requiredSkills = [...new Set(required.skills ?? [])]
  const fail = (message: string): never => { throw new ReviewError({ code: "policy_conflict", message }) }
  if (local.skills !== undefined && requiredSkills.some((skill) => !local.skills!.includes(skill))) {
    fail(`Repository skills cannot exclude organization-required lenses: ${requiredSkills.join(", ")}.`)
  }
  if (local.severity && required.minimumSeverity && ranks[local.severity.minimum] < ranks[required.minimumSeverity]) {
    fail(`Repository minimum severity cannot be below organization requirement ${required.minimumSeverity}.`)
  }
  if (local.minimumConfidence !== undefined && required.minimumConfidence !== undefined && local.minimumConfidence < required.minimumConfidence) {
    fail(`Repository minimum confidence cannot be below organization requirement ${required.minimumConfidence}.`)
  }
  let minimumSeverity = local.severity?.minimum ?? defaults?.severity?.minimum ?? "medium"
  if (required.minimumSeverity && ranks[minimumSeverity] < ranks[required.minimumSeverity]) minimumSeverity = required.minimumSeverity
  const paths = local.paths ?? defaults?.paths ?? []
  for (const { pattern } of paths) {
    if (pattern.startsWith("/") || pattern.includes("\\") || pattern.split("/").includes("..")) {
      throw new ReviewError({ code: "config_error", message: `Path pattern must be repository-relative with forward slashes: ${pattern}` })
    }
    try { picomatch(pattern, { dot: true, strictBrackets: true }) } catch (error) {
      throw new ReviewError({ code: "config_error", message: String(error) })
    }
  }
  return {
    source,
    skills: [...new Set<Skill>([...(local.skills ?? defaults?.skills ?? ["correctness", "security"]), ...requiredSkills])],
    minimumSeverity,
    minimumConfidence: Math.max(local.minimumConfidence ?? defaults?.minimumConfidence ?? 0.7, required.minimumConfidence ?? 0),
    paths,
    rules: [...new Set([...(local.rules ?? defaults?.rules ?? defaultRules), ...(required.rules ?? [])])],
    requiredSkills,
    organization: org?.lock ?? null,
    knowledge: org?.knowledge ?? []
  }
}
