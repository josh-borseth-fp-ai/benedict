import { Data, Schema } from "effect"
import { commentMarker } from "./publish.js"

export class StampError extends Data.TaggedError("StampError")<{
  readonly code: string
  readonly message: string
  readonly status: number
}> {}
export const stampError = (code: string, message: string, status = 409) => new StampError({ code, message, status })
/** A PR cannot stamp changes to review policy, its organization lock, or the stamping workflow itself. */
export const protectedPaths = [".benedict/**", ".agents/skills/benedict/**", "stamp-service/**", "src/stamp*.ts"]
export const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
/** Approval requires an overall review confidence of at least 4/5. */
export const minimumConfidence = 4
export const StampReport = Schema.Struct({
  version: Schema.Literal(2), pr: Schema.String, base: Sha, head: Sha,
  findings: Schema.Array(Schema.Unknown),
  dropped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skills: Schema.Array(Schema.Literals(["correctness", "security"])),
  confidence: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  reviewComment: Schema.String
})
export type StampReport = typeof StampReport.Type
export const StampResult = Schema.Struct({
  action: Schema.Literals(["approved", "already-approved"]), pr: Schema.String,
  head: Sha, approvedBy: Schema.String, reviewUrl: Schema.String
})
export type StampResult = typeof StampResult.Type

export const serviceUrl = (value: string): string => {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("stamp.service must be an HTTPS endpoint without credentials, query parameters or a fragment.")
  }
  return url.href
}

/**
 * Reads the overall confidence from a published review comment for exactly this range with no
 * accepted findings. Returns undefined when the comment does not record one unambiguous score.
 */
export const publishedConfidence = (body: string, base: string, head: string): number | undefined => {
  if (!body.startsWith(`${commentMarker}\n`)) return undefined
  if (!body.includes(`Reviewed commits: \`${base}\` → \`${head}\`.`) || !body.includes("Accepted findings: **0**.")) return undefined
  const scores = new Set([...body.matchAll(/^\s*(?:\*\*)?Confidence:\s*([1-5])\/5\b/gm)].map(match => Number(match[1])))
  return scores.size === 1 ? [...scores][0] : undefined
}
