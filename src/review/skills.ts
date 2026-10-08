import { Context, Effect, Layer } from "effect"
import { AgentBackend, decodeFindings, stampFinding } from "../agent/backend.js"
import { AgentError } from "../domain/Errors.js"
import { Finding, type SkillName } from "../domain/Model.js"
import { isCodePath } from "../intelligence/symbols.js"
import type { ReviewContext } from "./context.js"
import { skillsForPath } from "./config.js"
import { reviewPrompt } from "./prompt.js"

const instructions: Record<SkillName, string> = {
  correctness: `Look for broken control flow, incorrect assumptions, null or undefined cases, state inconsistencies, missing error handling, edge cases, and regressions caused by this diff.`,
  security: `Look for auth or authz mistakes, injection, secret exposure, unsafe deserialization, trust-boundary violations, and insecure defaults caused by this diff.`
}

const runSkill = Effect.fn("ReviewSkill.run")(function*(skill: SkillName, context: ReviewContext) {
  const backend = yield* AgentBackend
  const prompt = reviewPrompt({
    skill,
    instructions: instructions[skill],
    rules: context.rules,
    notes: context.notes,
    files: context.files,
    symbols: context.symbols,
    snippets: context.snippets,
    graph: context.graph
  })
  const result = yield* backend.run({
    purpose: "review",
    prompt,
    schemaName: "AgentFindings"
  })
  const decoded = yield* decodeFindings(result.text)
  return decoded.findings.map((finding) => stampFinding(skill, finding))
})

export interface ReviewSkill {
  readonly name: SkillName
  readonly shouldRun: (context: ReviewContext) => boolean
  readonly review: (context: ReviewContext) => Effect.Effect<ReadonlyArray<Finding>, AgentError, AgentBackend>
}

const skill = (name: SkillName): ReviewSkill => ({
  name,
  shouldRun: (context) => context.files.some((file) =>
    !file.binary && isCodePath(file.path) && skillsForPath(context.config, file.path).includes(name)
  ),
  review: (context) => runSkill(name, context)
})

export class SkillRegistry extends Context.Service<SkillRegistry, {
  readonly skills: ReadonlyArray<ReviewSkill>
}>()("review-runtime/SkillRegistry") {
  static readonly layer = Layer.succeed(SkillRegistry, {
    skills: [skill("correctness"), skill("security")]
  })
}
