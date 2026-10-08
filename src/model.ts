import { Data, Schema } from "effect"

export class ReviewError extends Data.TaggedError("ReviewError")<{
  readonly code: string
  readonly message: string
}> {}

export const Severity = Schema.Literals(["low", "medium", "high", "critical"])
export type Severity = typeof Severity.Type
export const Skill = Schema.Literals(["correctness", "security"])
export type Skill = typeof Skill.Type
export const NonBlank = Schema.String.check(Schema.makeFilter((value) => value.trim().length > 0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Confidence = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

export const Finding = Schema.Struct({
  file: NonBlank,
  startLine: PositiveInt,
  endLine: PositiveInt,
  severity: Severity,
  skill: Skill,
  title: NonBlank,
  explanation: NonBlank,
  quote: NonBlank,
  confidence: Confidence,
  suggestedFix: Schema.optional(NonBlank)
})
export type Finding = typeof Finding.Type

export const PolicyFields = {
  skills: Schema.optional(Schema.Array(Skill)),
  severity: Schema.optional(Schema.Struct({ minimum: Severity })),
  paths: Schema.optional(Schema.Array(Schema.Struct({
    pattern: NonBlank,
    skills: Schema.Array(Skill)
  }))),
  rules: Schema.optional(Schema.Array(NonBlank)),
  minimumConfidence: Schema.optional(Confidence)
}
export const OrganizationReference = Schema.Struct({ source: NonBlank, ref: Schema.optional(NonBlank) })
export type OrganizationReference = typeof OrganizationReference.Type
export const ConfigFile = Schema.Struct({
  ...PolicyFields,
  knowledge: Schema.optional(Schema.Array(NonBlank)),
  organization: Schema.optional(OrganizationReference),
  stamp: Schema.optional(Schema.Struct({
    enabled: Schema.optional(Schema.Boolean),
    team: Schema.optional(NonBlank),
    channel: Schema.optional(NonBlank),
    denyPaths: Schema.optional(Schema.Array(NonBlank)),
    maxChangedLines: Schema.optional(PositiveInt)
  }))
})
export type ConfigFile = typeof ConfigFile.Type

export const RequiredPolicy = Schema.Struct({
  skills: Schema.optional(Schema.Array(Skill)),
  minimumSeverity: Schema.optional(Severity),
  minimumConfidence: Schema.optional(Confidence),
  rules: Schema.optional(Schema.Array(NonBlank))
})
export type RequiredPolicy = typeof RequiredPolicy.Type
export const OrganizationManifest = Schema.Struct({
  defaults: Schema.optional(Schema.Struct(PolicyFields)),
  required: Schema.optional(RequiredPolicy),
  knowledge: Schema.optional(Schema.Array(NonBlank))
})
export type OrganizationManifest = typeof OrganizationManifest.Type

export const KnowledgeLock = Schema.Struct({
  version: Schema.Literal(1),
  source: NonBlank,
  ref: NonBlank,
  revision: Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/))
})
export type KnowledgeLock = typeof KnowledgeLock.Type

export interface KnowledgeDocument {
  readonly scope: "repository" | "organization"
  readonly path: string
  readonly content: string
}

export interface OrganizationBundle {
  readonly lock: KnowledgeLock
  readonly manifest: OrganizationManifest
  readonly knowledge: ReadonlyArray<KnowledgeDocument>
}

export interface ReviewConfig {
  readonly source: string | null
  readonly skills: ReadonlyArray<Skill>
  readonly minimumSeverity: Severity
  readonly minimumConfidence: number
  readonly paths: ReadonlyArray<{ readonly pattern: string; readonly skills: ReadonlyArray<Skill> }>
  readonly rules: ReadonlyArray<string>
  readonly requiredSkills: ReadonlyArray<Skill>
  readonly organization: KnowledgeLock | null
  readonly knowledge: ReadonlyArray<KnowledgeDocument>
}

export interface ReviewOptions {
  readonly repo: string
  readonly base?: string
  readonly head?: string
  readonly worktree: boolean
  readonly config?: string
}

export interface ReviewRange {
  readonly base: string
  readonly head: string | null
  readonly worktree: boolean
}

export interface ChangedFile {
  readonly path: string
  readonly oldPath?: string
  readonly status: "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed" | "untracked"
  readonly binary: boolean
  readonly reviewable: boolean
  readonly lineCount: number
  readonly changedLines: ReadonlyArray<number>
  readonly skills: ReadonlyArray<Skill>
  readonly patch: string
}

export interface ReviewContext {
  readonly formatVersion: 1
  readonly repository: string
  readonly range: ReviewRange
  readonly config: ReviewConfig
  readonly files: ReadonlyArray<ChangedFile>
}

/** Captured source stays internal; reports include only agent-provided evidence. */
export interface Snapshot {
  readonly context: ReviewContext
  readonly sources: ReadonlyMap<string, string>
}

export interface RejectionReason {
  readonly code: string
  readonly message: string
}

export interface CheckReport {
  readonly formatVersion: 1
  readonly repository: string
  readonly range: ReviewRange
  readonly accepted: ReadonlyArray<Finding>
  readonly organization: KnowledgeLock | null
  readonly rejected: ReadonlyArray<{
    readonly index: number
    readonly finding: unknown
    readonly reasons: ReadonlyArray<RejectionReason>
  }>
  readonly summary: { readonly accepted: number; readonly rejected: number }
}

export const sourceLines = (source: string): ReadonlyArray<string> => {
  if (source.length === 0) return []
  const lines = source.replace(/\r\n/g, "\n").split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}
