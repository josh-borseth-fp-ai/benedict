import { Effect } from "effect"
import { AgentBackend, decodeJudgement } from "../agent/backend.js"
import { AgentError } from "../domain/Errors.js"
import { Finding, RejectedFinding } from "../domain/Model.js"
import { judgePrompt } from "./prompt.js"
import type { ReviewContext } from "./context.js"

export const judgeFindings = Effect.fn("Judge.review")(function*(
  findings: ReadonlyArray<Finding>,
  context: ReviewContext
) {
  if (findings.length === 0) {
    return { kept: [] as ReadonlyArray<Finding>, rejected: [] as ReadonlyArray<RejectedFinding> }
  }
  const backend = yield* AgentBackend
  const evidence = [
    context.graph,
    ...context.snippets.map((snippet) => `${snippet.relation} ${snippet.path}:${snippet.startLine}\n${snippet.text}`)
  ].join("\n\n")
  const result = yield* backend.run({
    purpose: "judge",
    schemaName: "JudgementResult",
    prompt: judgePrompt({
      rules: context.rules,
      findingsJson: JSON.stringify(findings.map((finding, index) => ({
        index,
        file: finding.file,
        startLine: finding.startLine,
        endLine: finding.endLine,
        severity: finding.severity,
        title: finding.title,
        explanation: finding.explanation,
        evidence: finding.evidence,
        confidence: finding.confidence,
        skill: finding.skill
      })), null, 2),
      evidence
    })
  })
  const decoded = yield* decodeJudgement(result.text)
  const byIndex = new Map(decoded.judgements.map((item) => [item.index, item]))
  const kept: Array<Finding> = []
  const rejected: Array<RejectedFinding> = []
  findings.forEach((finding, index) => {
    const judgement = byIndex.get(index)
    if (judgement === undefined) {
      rejected.push(new RejectedFinding({ finding, reason: "judge did not confirm this finding" }))
      return
    }
    if (!judgement.accept) {
      rejected.push(new RejectedFinding({ finding, reason: judgement.reason }))
      return
    }
    const confidence = Math.min(finding.confidence, judgement.confidence)
    kept.push(new Finding({
      file: finding.file,
      startLine: finding.startLine,
      endLine: finding.endLine,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      explanation: finding.explanation,
      evidence: finding.evidence,
      ...(finding.suggestedFix === undefined ? {} : { suggestedFix: finding.suggestedFix }),
      confidence,
      skill: finding.skill
    }))
  })
  return { kept, rejected }
})

export const isDecodeError = (error: AgentError): boolean => error.kind === "decode"
