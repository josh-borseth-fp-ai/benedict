import { Match } from "effect"
import { Finding, RejectedFinding, type Severity } from "../domain/Model.js"

export const severityRank: (severity: Severity) => number = Match.type<Severity>().pipe(
  Match.when("low", () => 0),
  Match.when("medium", () => 1),
  Match.when("high", () => 2),
  Match.when("critical", () => 3),
  Match.exhaustive
)

export const dedupeFindings = (findings: ReadonlyArray<Finding>): ReadonlyArray<Finding> => {
  const kept = new Map<string, Finding>()
  for (const finding of findings) {
    const key = `${finding.file}:${finding.startLine}:${finding.title.trim().toLowerCase()}`
    const previous = kept.get(key)
    if (previous === undefined || finding.confidence > previous.confidence) kept.set(key, finding)
  }
  return [...kept.values()]
}

export const gateFindings = (input: {
  readonly findings: ReadonlyArray<Finding>
  readonly knownPaths: ReadonlySet<string>
}): { readonly kept: ReadonlyArray<Finding>; readonly rejected: ReadonlyArray<RejectedFinding> } => {
  const kept: Array<Finding> = []
  const rejected: Array<RejectedFinding> = []
  for (const finding of input.findings) {
    const reason = rejectionReason(finding, input.knownPaths)
    if (reason === undefined) kept.push(finding)
    else rejected.push(new RejectedFinding({ finding, reason }))
  }
  return { kept, rejected }
}

const rejectionReason = (finding: Finding, knownPaths: ReadonlySet<string>): string | undefined => {
  if (finding.evidence.length === 0 || finding.evidence.every((item) => item.trim() === "")) {
    return "finding has no evidence"
  }
  if (finding.explanation.trim() === "") return "finding has no explanation"
  if (finding.endLine < finding.startLine) return "line range is reversed"
  if (!knownPaths.has(finding.file)) return "file is outside the diff and the retrieved context"
  return undefined
}

export const applyFloor = (input: {
  readonly findings: ReadonlyArray<Finding>
  readonly minimumSeverity: Severity
  readonly minimumConfidence: number
}): { readonly kept: ReadonlyArray<Finding>; readonly rejected: ReadonlyArray<RejectedFinding> } => {
  const kept: Array<Finding> = []
  const rejected: Array<RejectedFinding> = []
  for (const finding of input.findings) {
    if (severityRank(finding.severity) < severityRank(input.minimumSeverity)) {
      rejected.push(new RejectedFinding({ finding, reason: "below minimum severity" }))
      continue
    }
    if (finding.confidence < input.minimumConfidence) {
      rejected.push(new RejectedFinding({ finding, reason: "below minimum confidence" }))
      continue
    }
    kept.push(finding)
  }
  return { kept, rejected }
}
