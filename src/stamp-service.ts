import { randomBytes, randomInt } from "node:crypto"
import { Clock, Effect, Schema } from "effect"
import picomatch from "picomatch"
import { ConfigFile, configPath } from "./model.js"
import { parseJson } from "./policy.js"
import { parsePullRequest } from "./publish.js"
import { StampGitHub } from "./stamp-github.js"
import { StampStore } from "./stamp-store.js"
import type { Enrollment, Reviewer } from "./stamp-store.js"
import { EnrollmentPoll, EnrollmentStart, PositiveInt, Sha, StampReport, protectedPaths, stampError } from "./stamp-protocol.js"
import type { StampResult } from "./stamp-protocol.js"

const Identity = Schema.Struct({ id: PositiveInt, login: Schema.String })
const Pr = Schema.Struct({ state: Schema.String, draft: Schema.Boolean, head: Schema.Struct({ sha: Sha }), base: Schema.Struct({ sha: Sha }), user: Identity, changed_files: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })
type Pr = typeof Pr.Type
const File = Schema.Struct({ filename: Schema.String, previous_filename: Schema.optional(Schema.String), additions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), deletions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), patch: Schema.optional(Schema.String) })
const Review = Schema.Struct({ state: Schema.String, commit_id: Schema.NullOr(Sha), html_url: Schema.String, user: Identity, body: Schema.NullOr(Schema.String) })
const Tokens = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.optional(Schema.String), expires_in: Schema.optional(PositiveInt) })
const Device = Schema.Struct({ device_code: Schema.String, user_code: Schema.String, verification_uri: Schema.Literal("https://github.com/login/device"), expires_in: PositiveInt, interval: PositiveInt })
const OAuthError = Schema.Struct({ error: Schema.String, interval: Schema.optional(PositiveInt) })

const decode = <S extends Schema.Top>(schema: S, value: unknown) => Schema.decodeUnknownEffect(schema)(value).pipe(
  Effect.mapError(() => stampError("invalid_response", "The stamp service received an invalid response.", 502))
)
const signature = (pr: Pr) => [pr.state, pr.draft, pr.head.sha, pr.base.sha, pr.user.id].join(":")

export const reviewerToken = Effect.fn("Stamp.reviewerToken")(function*(user: Reviewer) {
  const now = yield* Clock.currentTimeMillis
  if (user.expiresAt === 0 || user.expiresAt > now + 300_000) return user.accessToken
  if (!user.refreshToken) return yield* stampError("reviewer_expired", "Reviewer authorization expired; enroll again.")
  const gh = yield* StampGitHub
  const tokens = yield* decode(Tokens, yield* gh.oauth("refresh", { refresh_token: user.refreshToken }))
  const store = yield* StampStore
  yield* store.saveUser({ ...user, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? user.refreshToken, expiresAt: tokens.expires_in ? now + tokens.expires_in * 1000 : 0 })
  return tokens.access_token
})

const pages = Effect.fn("Stamp.pages")(function*<S extends Schema.Top>(token: string, endpoint: string, schema: S, maxPages = 100) {
  const gh = yield* StampGitHub
  const items: Array<S["Type"]> = []
  for (let page = 1; page <= maxPages; page++) {
    const batch = yield* decode(Schema.Array(schema), yield* gh.request(token, "GET", `${endpoint}?per_page=100&page=${page}`))
    items.push(...batch)
    if (batch.length < 100) return items
  }
  return yield* stampError("coverage", "Cannot inspect all GitHub pages; manual review is required.")
})

const checkPolicy = Effect.fn("Stamp.checkPolicy")(function*(token: string, repository: string, pr: Pr, report: StampReport, service: string) {
  if (pr.state !== "open" || pr.draft) return yield* stampError("stamp_refused", "Stamping requires an open, non-draft PR.")
  if (pr.head.sha !== report.head) return yield* stampError("stale_review", "The review is stale; review the current head.")
  const gh = yield* StampGitHub
  const comparison = yield* decode(Schema.Struct({ merge_base_commit: Schema.Struct({ sha: Sha }) }), yield* gh.request(token, "GET", `repos/${repository}/compare/${pr.base.sha}...${report.head}`))
  if (comparison.merge_base_commit.sha !== report.base) return yield* stampError("partial_review", "The review did not cover the whole PR.")
  const value = yield* gh.request(token, "GET", `repos/${repository}/contents/${configPath}?ref=${pr.base.sha}`).pipe(
    Effect.mapError((error) => error.code === "github_not_found" ? stampError("config_error", `The base branch must have ${configPath}.`) : error)
  )
  const content = yield* decode(Schema.Struct({ type: Schema.Literal("file"), encoding: Schema.Literal("base64"), content: Schema.String, size: Schema.Int }), value)
  if (content.size > 100_000) return yield* stampError("config_error", "The base config is too large.")
  const parsed = yield* parseJson(Buffer.from(content.content, "base64").toString("utf8"), configPath).pipe(Effect.mapError(() => stampError("config_error", "The base review config is invalid.")))
  const config = yield* Schema.decodeUnknownEffect(ConfigFile, { onExcessProperty: "error" })(parsed).pipe(
    Effect.mapError(() => stampError("config_error", "The base review config is invalid."))
  )
  const stamp = config.stamp
  if (!stamp?.enabled || stamp.service !== service) return yield* stampError("stamp_refused", "The base branch does not authorize this stamp service.")
  if (pr.changed_files > 3000) return yield* stampError("coverage", "The PR has too many changed files.")
  const files = yield* pages(token, `repos/${repository}/pulls/${parsePullRequest(report.pr).number}/files`, File, 31)
  if (files.length !== pr.changed_files) return yield* stampError("coverage", "Changed-file coverage is incomplete.")
  let lines = 0
  for (const file of files) {
    if (file.patch === undefined) return yield* stampError("coverage", "A changed file has no text patch; manual review is required.")
    for (const name of [file.filename, file.previous_filename].filter((name): name is string => name !== undefined)) {
      const protectedPath = [...protectedPaths, ...(stamp.denyPaths ?? [])].some(pattern => picomatch.isMatch(name, pattern, { dot: true, strictBrackets: true }))
      if (protectedPath) return yield* stampError("protected_path", `A protected path changed: ${name}.`)
    }
    lines += file.additions + file.deletions
  }
  if (lines > (stamp.maxChangedLines ?? 400)) return yield* stampError("size_limit", "The PR exceeds stamp.maxChangedLines.")
})

/** State and writes are owned by Effects; only explicit GitHub rejections allow another candidate. */
export const approveStamp = Effect.fn("Stamp.approve")(function*(value: unknown, allowed: ReadonlyArray<string>, service: string) {
  const report = yield* Schema.decodeUnknownEffect(StampReport, { onExcessProperty: "error" })(value).pipe(Effect.mapError(() => stampError("invalid_report", "Invalid version-1 stamp report.", 400)))
  const target = yield* Effect.try({ try: () => parsePullRequest(report.pr), catch: () => stampError("invalid_report", "Use a full GitHub PR URL.", 400) })
  if (!allowed.some(name => name.toLowerCase() === target.repository.toLowerCase())) return yield* stampError("repository_disabled", "This repository is not enabled on the service.")
  if (report.findings.length > 0) return yield* stampError("findings", "Accepted findings must be resolved before stamping.")
  const store = yield* StampStore
  const gh = yield* StampGitHub
  const candidates = [...(yield* store.users())]
  yield* Effect.sync(() => { for (let i = candidates.length - 1; i > 0; i--) { const j = randomInt(i + 1); [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!] } })
  const endpoint = `repos/${target.repository}/pulls/${target.number}`
  const key = `${target.repository}~${target.number}`
  const marker = `<!-- review-agent-stamp:${report.head} -->`
  const body = `🤖 **Review Agent — automated approval**\n\nReviewed \`${report.base}\` → \`${report.head}\`.\n\nAccepted findings: 0 · drafts dropped: ${report.dropped}.\n\nThis approval was submitted by the review agent through an opted-in GitHub reviewer account.\n\n${marker}`
  let baseline: Pr | undefined
  let reserved = false
  let failures = 0
  for (const user of candidates) {
    const tokenResult = yield* reviewerToken(user).pipe(Effect.result)
    if (tokenResult._tag === "Failure") { if (++failures >= 5) break; continue }
    const token = tokenResult.success
    const preflight = yield* Effect.gen(function*() {
      const identity = yield* decode(Identity, yield* gh.request(token, "GET", "user"))
      const pr = yield* decode(Pr, yield* gh.request(token, "GET", endpoint))
      return { identity, pr }
    }).pipe(Effect.result)
    if (preflight._tag === "Failure") { if (++failures >= 5) break; continue }
    const { identity, pr } = preflight.success
    if (identity.id !== user.id || identity.id === pr.user.id) continue
    if (!baseline) {
      yield* checkPolicy(token, target.repository, pr, report, service)
      baseline = pr
      const existing = yield* store.reserve(key, report.head)
      if (existing) {
        if (existing.status !== "approved" || !existing.result) return yield* stampError("stamp_pending", "A stamp for this commit is pending; inspect GitHub before clearing its reservation.")
        const reviews = yield* pages(token, `${endpoint}/reviews`, Review)
        if (!reviews.some(review => review.state === "APPROVED" && review.commit_id === report.head && review.html_url === existing.result!.reviewUrl)) return yield* stampError("stamp_dismissed", "The previous stamp was dismissed; reconcile that approval before stamping again.")
        return { ...existing.result, action: "already-approved" as const }
      }
      reserved = true
    }
    const reviews = yield* pages(token, `${endpoint}/reviews`, Review)
    const recovered = reviews.find(review => review.state === "APPROVED" && review.commit_id === report.head && review.body?.includes(marker) && candidates.some(candidate => candidate.id === review.user.id))
    if (recovered) {
      const result: StampResult = { action: "already-approved", pr: target.url, head: report.head, approvedBy: recovered.user.login, reviewUrl: recovered.html_url }
      yield* store.complete(key, report.head, result)
      return result
    }
    const current = yield* decode(Pr, yield* gh.request(token, "GET", endpoint))
    if (signature(current) !== signature(baseline) || signature(pr) !== signature(baseline)) {
      yield* store.release(key, report.head)
      return yield* stampError("stale_review", "The PR changed before approval; review its current range.")
    }
    // Finish write and persistence even if the HTTP caller disconnects. Unknown writes retain the reservation.
    const write = yield* Effect.uninterruptible(Effect.gen(function*() {
      const raw = yield* gh.request(token, "POST", `${endpoint}/reviews`, { event: "APPROVE", commit_id: report.head, body })
      const review = yield* decode(Review, raw)
      if (review.state !== "APPROVED" || review.commit_id !== report.head || review.user.id !== identity.id || !review.html_url.startsWith(`${target.url}#pullrequestreview-`)) return yield* stampError("write_uncertain", "GitHub returned an unexpected approval; inspect the PR.", 502)
      const result: StampResult = { action: "approved", pr: target.url, head: report.head, approvedBy: identity.login, reviewUrl: review.html_url }
      yield* store.complete(key, report.head, result)
      return result
    })).pipe(Effect.result)
    if (write._tag === "Success") return write.success
    if (write.failure.code !== "review_rejected") return yield* stampError("write_uncertain", "Stamp outcome is uncertain; inspect GitHub and the pending reservation before retrying.", 502)
    if (++failures >= 5) break
  }
  if (reserved) yield* store.release(key, report.head)
  return yield* stampError("no_reviewer", "No eligible opted-in reviewer could approve this PR.")
})

export const beginEnrollment = Effect.fn("Stamp.beginEnrollment")(function*() {
  const gh = yield* StampGitHub
  const device = yield* decode(Device, yield* gh.oauth("device"))
  const now = yield* Clock.currentTimeMillis
  const enrollment = yield* Effect.sync(() => randomBytes(32).toString("hex"))
  const store = yield* StampStore
  yield* store.createEnrollment(enrollment, { status: "pending", deviceCode: device.device_code, expiresAt: now + device.expires_in * 1000, interval: device.interval, nextPollAt: now + device.interval * 1000 })
  return yield* decode(EnrollmentStart, { enrollment, userCode: device.user_code, verificationUri: device.verification_uri, expiresIn: device.expires_in, interval: device.interval })
})

export const pollEnrollment = Effect.fn("Stamp.pollEnrollment")(function*(id: string) {
  if (!/^[a-f0-9]{64}$/.test(id)) return yield* stampError("invalid_enrollment", "Invalid enrollment ID.", 400)
  const store = yield* StampStore
  const { value, etag } = yield* store.enrollment(id)
  const now = yield* Clock.currentTimeMillis
  if (value.expiresAt <= now) return yield* stampError("enrollment_expired", "Enrollment expired; run enroll again.")
  if (value.status === "enrolled" && value.username) return { status: "enrolled" as const, username: value.username }
  if (value.status === "polling") return { status: "pending" as const, interval: value.interval }
  if (now < value.nextPollAt) return { status: "pending" as const, interval: Math.max(1, Math.ceil((value.nextPollAt - now) / 1000)) }
  const next: Enrollment = { ...value, status: "polling", nextPollAt: now + value.interval * 1000 }
  // Claim the exchange with an ETag. Unknown outcomes stay claimed until expiration;
  // a second caller cannot consume the same device code during a slow request.
  yield* store.updateEnrollment(id, next, etag)
  const locked = yield* store.enrollment(id)
  const gh = yield* StampGitHub
  const raw = yield* gh.oauth("poll", { device_code: value.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" })
  const tokens = yield* decode(Tokens, raw).pipe(Effect.result)
  if (tokens._tag === "Failure") {
    const error = yield* decode(OAuthError, raw)
    const completedAt = yield* Clock.currentTimeMillis
    if (error.error === "authorization_pending") {
      yield* store.updateEnrollment(id, { ...next, status: "pending", nextPollAt: completedAt + value.interval * 1000 }, locked.etag)
      return { status: "pending" as const, interval: value.interval }
    }
    if (error.error === "slow_down") {
      const interval = Math.max(error.interval ?? value.interval + 5, value.interval + 5)
      yield* store.updateEnrollment(id, { ...next, status: "pending", interval, nextPollAt: completedAt + interval * 1000 }, locked.etag)
      return { status: "pending" as const, interval }
    }
    return yield* stampError("enrollment_refused", "GitHub enrollment was refused or expired; start again.")
  }
  const identity = yield* decode(Identity, yield* gh.request(tokens.success.access_token, "GET", "user"))
  const user: Reviewer = { username: identity.login, id: identity.id, accessToken: tokens.success.access_token, refreshToken: tokens.success.refresh_token ?? "", expiresAt: tokens.success.expires_in ? now + tokens.success.expires_in * 1000 : 0 }
  yield* Effect.uninterruptible(Effect.gen(function*() {
    yield* store.saveUser(user)
    yield* store.updateEnrollment(id, { ...next, status: "enrolled", username: identity.login, deviceCode: "" }, locked.etag)
  }))
  return yield* decode(EnrollmentPoll, { status: "enrolled", username: identity.login })
})
