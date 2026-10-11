import { Data, Schema } from "effect"

export class ReviewError extends Data.TaggedError("ReviewError")<{
  readonly code: string
  readonly message: string
}> {}

export const Severity = Schema.Literals(["low", "medium", "high", "critical"])
export type Severity = typeof Severity.Type
/** Review skill names follow the Agent Skills convention and match their directory name. */
export const SkillName = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))
export const NonBlank = Schema.String.check(Schema.makeFilter((value) => value.trim().length > 0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const Confidence = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

export const Finding = Schema.Struct({
  file: NonBlank,
  startLine: PositiveInt,
  endLine: PositiveInt,
  severity: Severity,
  skill: SkillName,
  title: NonBlank,
  explanation: NonBlank,
  quote: NonBlank,
  confidence: Confidence,
  suggestedFix: Schema.optional(NonBlank)
})
export type Finding = typeof Finding.Type

/** Repository paths owned by the Benedict CLI. Every scope keeps its state under `.benedict/`. */
export const configPath = ".benedict/config.json"
export const skillsPath = ".benedict/skills"

/** The organization skills repository. Reviews always use the latest commit on its default branch. */
export const OrganizationReference = Schema.Struct({ source: NonBlank })
export type OrganizationReference = typeof OrganizationReference.Type
export const ConfigFile = Schema.Struct({
  $schema: Schema.optionalKey(NonBlank),
  organization: Schema.optionalKey(OrganizationReference)
})
export type ConfigFile = typeof ConfigFile.Type

/** The organization commit a review fetched, recorded so the review shows which skills it used. */
export interface OrganizationRevision {
  readonly source: string
  readonly revision: string
}

export type SkillScope = "built-in" | "organization" | "repository"

/** A review skill as listed in the review context; `paths` limits it to matching files. */
export interface SkillSummary {
  readonly name: string
  readonly description: string
  readonly scope: SkillScope
  readonly paths?: ReadonlyArray<string>
}

export interface ReviewSkill extends SkillSummary {
  readonly content: string
}

export interface ReviewOptions {
  readonly repo: string
  readonly base?: string
  readonly head?: string
  readonly worktree: boolean
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
  readonly skills: ReadonlyArray<string>
  readonly patch: string
}

export interface ReviewContext {
  readonly formatVersion: 1
  readonly repository: string
  readonly range: ReviewRange
  readonly pullRequest?: { readonly url: string }
  readonly organization: OrganizationRevision | null
  readonly skills: ReadonlyArray<SkillSummary>
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
  readonly organization: OrganizationRevision | null
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
