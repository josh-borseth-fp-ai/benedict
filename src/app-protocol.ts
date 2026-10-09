import { Data, Schema } from "effect"
import { Finding } from "./model.js"

export class ServiceError extends Data.TaggedError("ServiceError")<{
  readonly code: string
  readonly message: string
  readonly status: number
}> {}
export const serviceError = (code: string, message: string, status = 409) => new ServiceError({ code, message, status })
/** A PR cannot stamp changes to its review policy, organization lock or the Benedict skill. */
export const protectedPaths = [".benedict/**", ".agents/skills/benedict/**"]
export const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
/** Approval requires an overall review confidence of at least 4/5. */
export const minimumConfidence = 4

/** A review validated by the developer's CLI. The service renders and posts it as the GitHub App. */
export const ReviewRequest = Schema.Struct({
  version: Schema.Literal(1),
  pr: Schema.String,
  base: Sha, head: Sha,
  organizationRevision: Schema.NullOr(Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/))),
  findings: Schema.Array(Finding),
  dropped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  confidence: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  context: Schema.String,
  stamp: Schema.Boolean
})
export type ReviewRequest = typeof ReviewRequest.Type

export const StampOutcome = Schema.Union([
  Schema.Struct({ action: Schema.Literals(["approved", "already-approved"]), url: Schema.String }),
  Schema.Struct({ action: Schema.Literal("refused"), code: Schema.String, message: Schema.String })
])
export type StampOutcome = typeof StampOutcome.Type
export const ReviewResult = Schema.Struct({
  pr: Schema.String, head: Sha, postedBy: Schema.String,
  comment: Schema.Struct({ action: Schema.Literals(["created", "updated", "unchanged"]), url: Schema.String }),
  stamp: Schema.NullOr(StampOutcome)
})
export type ReviewResult = typeof ReviewResult.Type

/** Resolves the reviews endpoint under a trusted Benedict service base URL. */
export const reviewsEndpoint = (value: string): string => {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("The Benedict service URL must use HTTPS without credentials, query parameters or a fragment.")
  }
  url.pathname = url.pathname.replace(/\/*$/, "/")
  return new URL("api/reviews", url).href
}
