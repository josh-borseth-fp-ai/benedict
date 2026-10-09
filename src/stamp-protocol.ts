import { Data, Schema } from "effect"

export class StampError extends Data.TaggedError("StampError")<{
  readonly code: string
  readonly message: string
  readonly status: number
}> {}
export const stampError = (code: string, message: string, status = 409) => new StampError({ code, message, status })
/** A PR cannot stamp changes to review policy, its organization lock, or the stamping workflow itself. */
export const protectedPaths = [".review/**", ".agents/skills/review/**", "stamp-service/**", "src/stamp*.ts"]
export const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
export const StampReport = Schema.Struct({
  version: Schema.Literal(1), pr: Schema.String, base: Sha, head: Sha,
  findings: Schema.Array(Schema.Unknown),
  dropped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skills: Schema.Array(Schema.Literals(["correctness", "security"]))
})
export type StampReport = typeof StampReport.Type
export const StampResult = Schema.Struct({
  action: Schema.Literals(["approved", "already-approved"]), pr: Schema.String,
  head: Sha, approvedBy: Schema.String, reviewUrl: Schema.String
})
export type StampResult = typeof StampResult.Type
export const EnrollmentStart = Schema.Struct({
  enrollment: Schema.String, userCode: Schema.String,
  verificationUri: Schema.Literal("https://github.com/login/device"),
  expiresIn: PositiveInt, interval: PositiveInt
})
export const EnrollmentPoll = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending"), interval: PositiveInt }),
  Schema.Struct({ status: Schema.Literal("enrolled"), username: Schema.String })
])
export type EnrollmentPoll = typeof EnrollmentPoll.Type
export const ReviewerList = Schema.Struct({ users: Schema.Array(Schema.Struct({ username: Schema.String, id: PositiveInt })) })
export const RemovedReviewer = Schema.Struct({ removed: Schema.String })

export const serviceUrl = (value: string): string => {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("stamp.service must be an HTTPS endpoint without credentials, query parameters or a fragment.")
  }
  return url.href
}

/** The configured stamp endpoint fixes all management routes to the same trusted origin. */
export const managementUrl = (trusted: string, suffix: string): string => {
  const url = new URL(serviceUrl(trusted))
  if (!url.pathname.endsWith("/api/stamp")) throw new Error("REVIEW_STAMP_URL must end with /api/stamp.")
  url.pathname = url.pathname.slice(0, -"stamp".length) + suffix
  return url.href
}
