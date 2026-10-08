import { Effect, FileSystem, Schema } from "effect"
import { Finding, ReviewError, sourceLines } from "./model.js"
import type { CheckReport, RejectionReason, Severity, Snapshot } from "./model.js"

const rank: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 }

export const readFindings = Effect.fn("Review.readFindings")(function*(filename: string) {
  const fs = yield* FileSystem.FileSystem
  const content = yield* fs.readFileString(filename)
  const input = yield* Effect.try({
    try: () => JSON.parse(content) as unknown,
    catch: (error) => new ReviewError({ code: "input_error", message: `Invalid findings JSON: ${String(error)}` })
  })
  if (Array.isArray(input)) return input as unknown[]
  if (typeof input === "object" && input !== null && "findings" in input && Array.isArray(input.findings)) {
    return input.findings as unknown[]
  }
  return yield* new ReviewError({ code: "input_error", message: 'Expected an array of findings or an object with a "findings" array.' })
})

export const checkFindings = Effect.fn("Review.checkFindings")(function*(snapshot: Snapshot, drafts: ReadonlyArray<unknown>) {
  const { context, sources } = snapshot
  const files = new Map(context.files.map((file) => [file.path, file]))
  const candidates: Array<{ index: number; finding: Finding; reasons: RejectionReason[] }> = []
  const rejected: Array<CheckReport["rejected"][number]> = []
  for (const [index, draft] of drafts.entries()) {
    const decoded = yield* Schema.decodeUnknownEffect(Finding, { onExcessProperty: "error" })(draft).pipe(
      Effect.match({
        onSuccess: (finding) => ({ finding, error: null }),
        onFailure: (error) => ({ finding: null, error: error.message })
      })
    )
    if (decoded.finding === null) {
      rejected.push({ index, finding: draft, reasons: [{ code: "invalid_finding", message: decoded.error! }] })
      continue
    }
    const finding = decoded.finding
    const reasons: RejectionReason[] = []
    const fail = (code: string, message: string) => reasons.push({ code, message })
    // Paths match the diff exactly; aliases and traversals cannot name another file.
    const file = files.get(finding.file)
    if (!file) {
      fail("outside_diff", "File is not in the selected diff. Use its exact repository-relative path.")
    } else if (file.binary) {
      fail("binary_file", "Binary files cannot carry source findings.")
    } else if (!file.reviewable) {
      fail("unsupported_file", "The file is deleted, a symlink, a submodule, or another unsupported file type.")
    } else {
      if (!file.skills.includes(finding.skill)) fail("skill_not_allowed", `The ${finding.skill} lens is not allowed for this path.`)
      if (finding.startLine > finding.endLine || finding.endLine > file.lineCount) {
        fail("invalid_range", `Line range must be ordered and inside the reviewed file (${file.lineCount} lines).`)
      } else {
        const source = sources.get(finding.file)!.replace(/\r\n/g, "\n")
        const hasFinalNewline = finding.endLine < file.lineCount || source.endsWith("\n")
        const excerpt = sourceLines(source).slice(finding.startLine - 1, finding.endLine).join("\n") + (hasFinalNewline ? "\n" : "")
        if (!excerpt.includes(finding.quote.replace(/\r\n/g, "\n"))) {
          fail("quote_mismatch", "Evidence quote does not occur within the supplied line range in the reviewed source.")
        }
      }
    }
    if (rank[finding.severity] < rank[context.config.minimumSeverity]) fail("below_severity", `Minimum severity is ${context.config.minimumSeverity}.`)
    if (finding.confidence < context.config.minimumConfidence) fail("below_confidence", `Minimum confidence is ${context.config.minimumConfidence}.`)
    candidates.push({ index, finding, reasons })
  }

  const winners = new Map<string, typeof candidates[number]>()
  const keyOf = (finding: Finding) => JSON.stringify([finding.file, finding.startLine, finding.title])
  for (const candidate of candidates) {
    if (candidate.reasons.length > 0) continue
    const key = keyOf(candidate.finding)
    const previous = winners.get(key)
    if (previous === undefined || candidate.finding.confidence > previous.finding.confidence) winners.set(key, candidate)
  }
  const accepted: Finding[] = []
  for (const candidate of candidates) {
    if (candidate.reasons.length === 0 && winners.get(keyOf(candidate.finding)) !== candidate) {
      candidate.reasons.push({ code: "duplicate", message: "Another finding with the same file, start line and title has equal or higher confidence." })
    }
    if (candidate.reasons.length === 0) accepted.push(candidate.finding)
    else rejected.push({ index: candidate.index, finding: drafts[candidate.index], reasons: candidate.reasons })
  }
  rejected.sort((a, b) => a.index - b.index)
  return {
    formatVersion: 1,
    repository: context.repository,
    range: context.range,
    accepted,
    rejected,
    summary: { accepted: accepted.length, rejected: rejected.length }
  } satisfies CheckReport
})
