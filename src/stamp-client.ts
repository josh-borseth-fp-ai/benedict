import { Clock, Console, Effect, Schema } from "effect"
import { Prompt } from "effect/cli"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { ReviewError } from "./model.js"
import { EnrollmentPoll, EnrollmentStart, managementUrl, RemovedReviewer, ReviewerList } from "./stamp-protocol.js"

const request = Effect.fn("Stamp.clientRequest")(function*(method: "GET" | "POST", suffix: string, keyName: string, body?: unknown) {
  const trusted = process.env.REVIEW_STAMP_URL
  const key = process.env[keyName]
  if (!trusted || !key?.trim()) return yield* new ReviewError({ code: "stamp_auth", message: `Configure REVIEW_STAMP_URL and ${keyName} for this operation.` })
  const url = yield* Effect.try({ try: () => managementUrl(trusted, suffix), catch: () => new ReviewError({ code: "stamp_auth", message: "Configure a trusted HTTPS /api/stamp endpoint in REVIEW_STAMP_URL." }) })
  const http = yield* HttpClient.HttpClient
  let input = HttpClientRequest.make(method)(url).pipe(HttpClientRequest.setHeader("x-review-key", key))
  if (body !== undefined) input = input.pipe(HttpClientRequest.bodyJsonUnsafe(body))
  const response = yield* http.execute(input).pipe(Effect.timeout("30 seconds"), Effect.mapError(() => new ReviewError({ code: "stamp_service_error", message: "Stamp management request failed; no automatic retry was made." })))
  if (response.status < 200 || response.status >= 300) return yield* new ReviewError({ code: "stamp_service_error", message: `Stamp management request returned HTTP ${response.status}. Check the key, enrollment status and service.` })
  return yield* response.json.pipe(Effect.mapError(() => new ReviewError({ code: "stamp_service_error", message: "Invalid stamp service response." })))
})
const decode = <S extends Schema.Top>(schema: S, value: unknown) => Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => new ReviewError({ code: "stamp_service_error", message: "Invalid stamp service response." })))
const withHttp = <A, E, R>(effect: Effect.Effect<A, E, R | HttpClient.HttpClient>) => effect.pipe(
  Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" })
)

export const enrollReviewer = Effect.fn("Stamp.enrollReviewer")(function*(yes: boolean) {
  yield* Console.error("Enrollment allows the service to submit AI-attributed approvals using your GitHub account for enabled repositories. Your own PRs are excluded.")
  const consent = yes || (yield* Prompt.Confirm({ message: "Enroll your GitHub account in the reviewer pool?", initial: false }))
  if (!consent) return { action: "cancelled" as const }
  const started = yield* withHttp(request("POST", "enroll/start", "REVIEW_STAMP_ENROLL_KEY", { consent: true }).pipe(Effect.flatMap(value => decode(EnrollmentStart, value))))
  yield* Console.error(`Open ${started.verificationUri} and enter code ${started.userCode}. Waiting for GitHub authorization…`)
  const deadline = (yield* Clock.currentTimeMillis) + started.expiresIn * 1000
  let interval = started.interval
  while ((yield* Clock.currentTimeMillis) < deadline) {
    yield* Effect.sleep(`${interval} seconds`)
    const result = yield* withHttp(request("POST", "enroll/poll", "REVIEW_STAMP_ENROLL_KEY", { enrollment: started.enrollment }).pipe(Effect.flatMap(value => decode(EnrollmentPoll, value))))
    if (result.status === "enrolled") return { action: "enrolled" as const, username: result.username }
    interval = result.interval
  }
  return yield* new ReviewError({ code: "enrollment_expired", message: "Enrollment expired; run review stamp enroll again." })
})
export const listReviewers = () => withHttp(request("GET", "users", "REVIEW_STAMP_ADMIN_KEY").pipe(Effect.flatMap(value => decode(ReviewerList, value))))
export const removeReviewer = (username: string) => withHttp(request("POST", "users/remove", "REVIEW_STAMP_ADMIN_KEY", { username }).pipe(Effect.flatMap(value => decode(RemovedReviewer, value))))
