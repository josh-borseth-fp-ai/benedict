import { Console, Effect, Schema } from "effect"
import { ReviewReport, type OutputFormat } from "../domain/Model.js"

const encodeReport = Schema.encodeEffect(ReviewReport)

export const reportJson = (report: ReviewReport) =>
  encodeReport(report).pipe(Effect.map((encoded) => JSON.stringify(encoded, null, 2)))

export const reportText = (report: ReviewReport): string => {
  const header = [
    "review-runtime",
    `base ${report.base}  head ${report.head}  backend ${report.backend}`,
    `files ${report.files.length}  symbols ${report.symbols.length}  findings ${report.findings.length}  rejected ${report.rejected.length}`
  ]
  if (report.warnings.length > 0) {
    header.push(report.warnings.map((warning) => `warning: ${warning}`).join("\n"))
  }
  if (report.findings.length === 0) {
    return [...header, "", "No high-confidence findings."].join("\n")
  }
  const body = report.findings.map((finding) => {
    const lines = [
      `[${finding.severity}] ${finding.category}  ${finding.file}:${finding.startLine}-${finding.endLine}  ${finding.title}`,
      `  ${finding.explanation}`,
      ...finding.evidence.map((item) => `  evidence: ${item}`),
      `  confidence ${finding.confidence.toFixed(2)}  skill ${finding.skill}`
    ]
    if (finding.suggestedFix !== undefined) lines.push(`  fix: ${finding.suggestedFix}`)
    return lines.join("\n")
  })
  return [...header, "", ...body].join("\n")
}

export const renderReport = Effect.fn("Report.render")(function*(
  report: ReviewReport,
  format: OutputFormat
) {
  const json = yield* reportJson(report)
  if (format === "json") {
    yield* Console.log(json)
    return
  }
  yield* Console.log(reportText(report))
  if (format === "both") {
    yield* Console.log("\n---\n")
    yield* Console.log(json)
  }
})
