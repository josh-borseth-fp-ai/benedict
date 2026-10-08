import { Schema } from "effect"

export const Severity = Schema.Literals(["low", "medium", "high", "critical"])
export type Severity = typeof Severity.Type

export const SkillName = Schema.Literals(["correctness", "security"])
export type SkillName = typeof SkillName.Type

export const BackendName = Schema.Literals(["codex", "claude"])
export type BackendName = typeof BackendName.Type

export const OutputFormat = Schema.Literals(["text", "json", "both"])
export type OutputFormat = typeof OutputFormat.Type

export const SymbolKind = Schema.Literals([
  "function",
  "method",
  "class",
  "interface",
  "type",
  "enum",
  "variable"
])
export type SymbolKind = typeof SymbolKind.Type

export const FileStatus = Schema.Literals(["added", "modified", "deleted", "renamed"])
export type FileStatus = typeof FileStatus.Type

export const Confidence = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export class CodeSymbol extends Schema.Class<CodeSymbol>("CodeSymbol")({
  name: Schema.String,
  kind: SymbolKind,
  path: Schema.String,
  startLine: PositiveInt,
  endLine: PositiveInt,
  signature: Schema.String
}) {}

export class FileDiff extends Schema.Class<FileDiff>("FileDiff")({
  path: Schema.String,
  oldPath: Schema.optional(Schema.String),
  status: FileStatus,
  binary: Schema.Boolean,
  touchedLines: Schema.Array(PositiveInt),
  patch: Schema.String
}) {}

export class Location extends Schema.Class<Location>("Location")({
  path: Schema.String,
  line: PositiveInt,
  text: Schema.String
}) {}

export class Snippet extends Schema.Class<Snippet>("Snippet")({
  path: Schema.String,
  startLine: PositiveInt,
  endLine: PositiveInt,
  relation: Schema.Literals(["definition", "caller", "callee", "reference", "test"]),
  text: Schema.String
}) {}

export class Finding extends Schema.Class<Finding>("Finding")({
  file: Schema.String,
  startLine: PositiveInt,
  endLine: PositiveInt,
  severity: Severity,
  category: SkillName,
  title: Schema.String,
  explanation: Schema.String,
  evidence: Schema.Array(Schema.String),
  suggestedFix: Schema.optional(Schema.String),
  confidence: Confidence,
  skill: SkillName
}) {}

/** Shape the agent is allowed to return. The runtime stamps skill and category. */
export class AgentFinding extends Schema.Class<AgentFinding>("AgentFinding")({
  file: Schema.String,
  startLine: PositiveInt,
  endLine: PositiveInt,
  severity: Severity,
  title: Schema.String,
  explanation: Schema.String,
  evidence: Schema.Array(Schema.String),
  suggestedFix: Schema.optional(Schema.String),
  confidence: Confidence
}) {}

export class AgentFindings extends Schema.Class<AgentFindings>("AgentFindings")({
  findings: Schema.Array(AgentFinding)
}) {}

export class Judgement extends Schema.Class<Judgement>("Judgement")({
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  accept: Schema.Boolean,
  confidence: Confidence,
  reason: Schema.String
}) {}

export class JudgementResult extends Schema.Class<JudgementResult>("JudgementResult")({
  judgements: Schema.Array(Judgement)
}) {}

export class RejectedFinding extends Schema.Class<RejectedFinding>("RejectedFinding")({
  finding: Finding,
  reason: Schema.String
}) {}

export class ReviewReport extends Schema.Class<ReviewReport>("ReviewReport")({
  generatedAt: Schema.String,
  repository: Schema.String,
  base: Schema.String,
  head: Schema.String,
  backend: BackendName,
  files: Schema.Array(Schema.String),
  symbols: Schema.Array(CodeSymbol),
  rules: Schema.Array(Schema.String),
  findings: Schema.Array(Finding),
  rejected: Schema.Array(RejectedFinding),
  warnings: Schema.Array(Schema.String)
}) {}

export const ReviewConfigFile = Schema.Struct({
  skills: Schema.optional(Schema.Array(SkillName)),
  severity: Schema.optional(Schema.Struct({
    minimum: Severity
  })),
  paths: Schema.optional(Schema.Array(Schema.Struct({
    pattern: Schema.String,
    skills: Schema.Array(SkillName)
  }))),
  rules: Schema.optional(Schema.Array(Schema.String)),
  minimumConfidence: Schema.optional(Confidence)
})
export type ReviewConfigFile = typeof ReviewConfigFile.Type

export interface ResolvedReviewConfig {
  readonly skills: ReadonlyArray<SkillName>
  readonly minimumSeverity: Severity
  readonly minimumConfidence: number
  readonly paths: ReadonlyArray<{
    readonly pattern: string
    readonly skills: ReadonlyArray<SkillName>
  }>
  readonly rules: ReadonlyArray<string>
}

export interface AgentRequest {
  readonly purpose: "review" | "judge"
  readonly prompt: string
  readonly schemaName: string
}

export class AgentResult extends Schema.Class<AgentResult>("AgentResult")({
  backend: BackendName,
  text: Schema.String
}) {}
