import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Layer, Redacted } from "effect"
import { HttpRouter } from "effect/http"
import { approveStamp, beginEnrollment, pollEnrollment, reviewerToken } from "../src/stamp-service.js"
import { StampGitHub } from "../src/stamp-github.js"
import { StampStore } from "../src/stamp-store.js"
import type { Enrollment, Reservation, Reviewer } from "../src/stamp-store.js"
import { stampError } from "../src/stamp-protocol.js"
import type { StampError } from "../src/stamp-protocol.js"
import { readServerConfig, stampRoutes } from "../src/stamp-server.js"

const base = "a".repeat(40), head = "b".repeat(40)
const prUrl = "https://github.com/acme/project/pull/7"
const service = "https://stamp.example.invalid/api/stamp"

const fixture = () => {
  let pool: Reviewer[] = [
    { username: "author", id: 1, accessToken: "author-token", refreshToken: "", expiresAt: 0 },
    { username: "reviewer", id: 2, accessToken: "reviewer-token", refreshToken: "", expiresAt: 0 }
  ]
  const enrollments = new Map<string, { value: Enrollment; etag: string }>()
  const reservations = new Map<string, Reservation>()
  let version = 0
  const store = StampStore.of({
    users: () => Effect.succeed([...pool]),
    saveUser: user => Effect.sync(() => { pool = [...pool.filter(u => u.id !== user.id), user] }),
    removeUser: name => Effect.sync(() => { pool = pool.filter(u => u.username !== name) }),
    createEnrollment: (id, value) => Effect.sync(() => { enrollments.set(id, { value, etag: String(++version) }) }),
    enrollment: id => enrollments.has(id) ? Effect.succeed(enrollments.get(id)!) : Effect.fail(stampError("not_found", "Not found.", 404)),
    updateEnrollment: (id, value, etag) => Effect.suspend(() => {
      if (enrollments.get(id)?.etag !== etag) return Effect.fail(stampError("storage_conflict", "Concurrent update."))
      return Effect.sync(() => { enrollments.set(id, { value, etag: String(++version) }) })
    }),
    reserve: (key, sha) => Effect.sync(() => { const id = `${key}:${sha}`; if (reservations.has(id)) return reservations.get(id)!; reservations.set(id, { status: "pending" }); return null }),
    complete: (key, sha, result) => Effect.sync(() => { reservations.set(`${key}:${sha}`, { status: "approved", result }) }),
    release: (key, sha) => Effect.sync(() => { reservations.delete(`${key}:${sha}`) })
  })
  const state = {
    pr: { state: "open", draft: false, head: { sha: head }, base: { sha: base }, user: { id: 1, login: "author" }, changed_files: 1 },
    mergeBase: base,
    config: JSON.stringify({ stamp: { enabled: true, service } }),
    files: [{ filename: "safe.ts", additions: 1, deletions: 1, patch: "@@ ..." }] as Array<{ filename: string; additions: number; deletions: number; patch?: string; previous_filename?: string }>,
    reviews: [] as Array<{ state: string; commit_id: string; html_url: string; user: { id: number; login: string }; body: string }>,
    writes: [] as Array<{ token: string; body: { commit_id: string; body: string; event: string } }>,
    rejectTokens: new Set<string>(), unknownWrite: false, mutateAfterReviews: false,
    oauth: { access_token: "reviewer-token", refresh_token: "refresh", expires_in: 3600 } as unknown,
    oauthCalls: [] as Array<{ action: string; payload?: Readonly<Record<string, string>> }>
  }
  const gh = StampGitHub.of({
    request: (token, method, endpoint, body) => Effect.suspend<unknown, StampError, never>(() => {
      if (endpoint === "user") { const user = pool.find(u => u.accessToken === token)!; return Effect.succeed({ id: user.id, login: user.username }) }
      if (method === "POST") {
        const payload = body as { commit_id: string; body: string; event: string }
        state.writes.push({ token, body: payload })
        if (state.rejectTokens.has(token)) return Effect.fail(stampError("review_rejected", "Rejected."))
        const user = pool.find(u => u.accessToken === token)!
        const review = { state: "APPROVED", commit_id: payload.commit_id, html_url: prUrl + "#pullrequestreview-99", user: { id: user.id, login: user.username }, body: payload.body }
        state.reviews.push(review)
        return state.unknownWrite ? Effect.fail(stampError("write_uncertain", "Lost response.", 502)) : Effect.succeed(review)
      }
      if (endpoint.includes("/compare/")) return Effect.succeed({ merge_base_commit: { sha: state.mergeBase } })
      if (endpoint.includes("/contents/")) return endpoint.includes("/contents/.review/config.json?") ? Effect.succeed({ type: "file", encoding: "base64", content: Buffer.from(state.config).toString("base64"), size: state.config.length }) : Effect.fail(stampError("github_not_found", "Not found.", 404))
      if (endpoint.includes("/files?")) return Effect.succeed(state.files)
      if (endpoint.includes("/reviews?")) { if (state.mutateAfterReviews) state.pr.head.sha = "c".repeat(40); return Effect.succeed(state.reviews) }
      return Effect.succeed(structuredClone(state.pr))
    }),
    oauth: (action, payload) => Effect.sync(() => {
      state.oauthCalls.push({ action, payload })
      return action === "device" ? { device_code: "private-device-code", user_code: "TEST-CODE", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 } : state.oauth
    })
  })
  const report = { version: 1, pr: prUrl, base, head, findings: [], dropped: 2, skills: ["correctness", "security"] }
  const run = <A, E>(effect: Effect.Effect<A, E, StampStore | StampGitHub>) => Effect.runPromise(effect.pipe(Effect.provideService(StampStore, store), Effect.provideService(StampGitHub, gh)))
  const approve = () => run(approveStamp(report, ["acme/project"], service))
  return { state, store, gh, report, run, approve, reservations, enrollments, pool: () => pool }
}

test("Effect stamp excludes the author, pins the commit, attributes AI, and prevents duplicates", async () => {
  const f = fixture()
  const result = await f.approve()
  assert.equal(result.approvedBy, "reviewer")
  assert.equal(f.state.writes[0]?.body.commit_id, head)
  assert.match(f.state.writes[0]!.body.body, /automated approval/)
  assert.equal((await f.approve()).action, "already-approved")
  assert.equal(f.state.writes.length, 1)
})

test("an uncertain write retains the reservation and never retries another reviewer", async () => {
  const f = fixture()
  f.state.unknownWrite = true
  const error = await f.run(approveStamp(f.report, ["acme/project"], service).pipe(Effect.flip))
  assert.equal(error.code, "write_uncertain")
  const again = await f.run(approveStamp(f.report, ["acme/project"], service).pipe(Effect.flip))
  assert.equal(again.code, "stamp_pending")
  assert.equal(f.state.writes.length, 1)
})

test("explicit GitHub refusal releases the reservation when there is no eligible reviewer", async () => {
  const f = fixture()
  f.state.rejectTokens.add("reviewer-token")
  const error = await f.run(approveStamp(f.report, ["acme/project"], service).pipe(Effect.flip))
  assert.equal(error.code, "no_reviewer")
  assert.equal(f.reservations.size, 0)
})

test("server rechecks allowlist, findings, current whole-PR range and protected rename sources", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.report.findings.push({ title: "bug" } as never) },
    (f: ReturnType<typeof fixture>) => { f.state.pr.head.sha = "c".repeat(40) },
    (f: ReturnType<typeof fixture>) => { f.state.mergeBase = "c".repeat(40) },
    (f: ReturnType<typeof fixture>) => { f.state.pr.draft = true },
    (f: ReturnType<typeof fixture>) => { f.state.config = JSON.stringify({ stamp: { enabled: false, service } }) },
    (f: ReturnType<typeof fixture>) => { f.state.config = "stamp:\n  enabled: true\n" },
    (f: ReturnType<typeof fixture>) => { f.state.files[0]!.filename = ".review/knowledge.lock.json" },
    (f: ReturnType<typeof fixture>) => { f.state.files[0]!.previous_filename = ".agents/skills/review/SKILL.md" },
    (f: ReturnType<typeof fixture>) => { f.state.files[0]!.additions = 401 },
    (f: ReturnType<typeof fixture>) => { delete f.state.files[0]!.patch },
    (f: ReturnType<typeof fixture>) => { f.state.mutateAfterReviews = true }
  ]
  for (const mutate of mutations) {
    const f = fixture(); mutate(f)
    await f.run(approveStamp(f.report, ["acme/project"], service).pipe(Effect.flip))
    assert.equal(f.state.writes.length, 0)
  }
  const f = fixture()
  const error = await f.run(approveStamp(f.report, ["other/project"], service).pipe(Effect.flip))
  assert.equal(error.code, "repository_disabled")
})

test("a dismissed approval is not silently reapproved", async () => {
  const f = fixture(); await f.approve()
  f.state.reviews[0]!.state = "DISMISSED"
  const error = await f.run(approveStamp(f.report, ["acme/project"], service).pipe(Effect.flip))
  assert.equal(error.code, "stamp_dismissed")
  assert.equal(f.state.writes.length, 1)
})

test("device enrollment returns only a user code, enforces poll interval, and persists the identity", async () => {
  const f = fixture()
  const begun = await f.run(beginEnrollment())
  assert.equal(begun.userCode, "TEST-CODE")
  assert.ok(!JSON.stringify(begun).includes("private-device-code"))
  assert.equal((await f.run(pollEnrollment(begun.enrollment))).status, "pending")
  assert.equal(f.state.oauthCalls.length, 1)
  const record = f.enrollments.get(begun.enrollment)!
  record.value = { ...record.value, nextPollAt: 0 }
  const result = await f.run(pollEnrollment(begun.enrollment))
  assert.deepEqual(result, { status: "enrolled", username: "reviewer" })
  assert.equal(f.enrollments.get(begun.enrollment)!.value.deviceCode, "")
  assert.equal(f.pool().find(user => user.username === "reviewer")?.refreshToken, "refresh")
})

test("device flow honors slow_down, denial and expiration without enrolling", async () => {
  for (const oauth of [{ error: "slow_down", interval: 12 }, { error: "access_denied" }]) {
    const f = fixture(), begun = await f.run(beginEnrollment())
    const record = f.enrollments.get(begun.enrollment)!
    record.value = { ...record.value, nextPollAt: 0 }
    f.state.oauth = oauth
    if (oauth.error === "slow_down") assert.deepEqual(await f.run(pollEnrollment(begun.enrollment)), { status: "pending", interval: 12 })
    else assert.equal((await f.run(pollEnrollment(begun.enrollment).pipe(Effect.flip))).code, "enrollment_refused")
    assert.equal(f.pool()[1]?.refreshToken, "")
  }
  const f = fixture(), begun = await f.run(beginEnrollment())
  const record = f.enrollments.get(begun.enrollment)!
  record.value = { ...record.value, expiresAt: 0 }
  assert.equal((await f.run(pollEnrollment(begun.enrollment).pipe(Effect.flip))).code, "enrollment_expired")
})

test("concurrent enrollment polls cannot exchange the same code while GitHub is slow", async () => {
  const f = fixture(), begun = await f.run(beginEnrollment())
  const record = f.enrollments.get(begun.enrollment)!
  record.value = { ...record.value, nextPollAt: 0 }
  let unblock!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let exchanges = 0
  const gh = StampGitHub.of({ ...f.gh, oauth: (action, payload) => action === "poll" ?
    Effect.promise(async () => { exchanges++; entered(); await blocked; return f.state.oauth }) : f.gh.oauth(action, payload) })
  const first = f.run(pollEnrollment(begun.enrollment).pipe(Effect.provideService(StampGitHub, gh)))
  await started
  try {
    // The claim remains exclusive even after the normal five-second poll interval.
    const claimed = f.enrollments.get(begun.enrollment)!
    claimed.value = { ...claimed.value, nextPollAt: 0 }
    assert.equal((await f.run(pollEnrollment(begun.enrollment))).status, "pending")
    assert.equal(exchanges, 1)
    assert.equal(f.state.oauthCalls.length, 1)
  } finally { unblock() }
  assert.equal((await first).status, "enrolled")
})

test("expired tokens are refreshed through Effects and never reused after a failed refresh", async () => {
  const f = fixture()
  const user = { ...f.pool()[1]!, expiresAt: 1, refreshToken: "refresh" }
  f.state.oauth = { error: "bad_refresh_token" }
  await f.run(reviewerToken(user).pipe(Effect.flip))
  assert.equal(f.pool()[1]?.accessToken, "reviewer-token")
  f.state.oauth = { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }
  assert.equal(await f.run(reviewerToken(user)), "new-access")
  assert.equal(f.pool()[1]?.refreshToken, "new-refresh")
})

test("JSON-only routes separate stamp, enrollment and admin keys and never expose tokens", async t => {
  const f = fixture()
  const config = { service, repositories: ["acme/project"], stampKey: Redacted.make("stamp-key"), enrollKey: Redacted.make("enroll-key"), adminKey: Redacted.make("admin-key") }
  const app = Layer.mergeAll(stampRoutes(config), Layer.succeed(StampStore)(f.store), Layer.succeed(StampGitHub)(f.gh))
  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true })
  t.after(dispose)
  const call = (path: string, key: string, body?: unknown) => handler(new Request("https://stamp.example.invalid" + path, { method: body ? "POST" : "GET", headers: { "x-review-key": key, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }))
  assert.equal((await call("/api/users", "stamp-key")).status, 401)
  const users = await call("/api/users", "admin-key")
  assert.deepEqual(await users.json(), { users: [{ username: "author", id: 1 }, { username: "reviewer", id: 2 }] })
  assert.equal((await call("/api/enroll/start", "enroll-key", { consent: false })).status, 400)
  const started = await call("/api/enroll/start", "enroll-key", { consent: true })
  assert.equal(started.status, 200)
  assert.ok(!(await started.text()).includes("private-device-code"))
  assert.equal((await call("/api/enroll", "enroll-key")).status, 404)
  assert.equal((await call("/api/stamp", "enroll-key", f.report)).status, 401)
  assert.equal((await call("/api/stamp", "stamp-key", f.report)).status, 200)
})

test("service configuration rejects insecure URLs, weak/shared keys and empty allowlists", async () => {
  const env = { STAMP_PUBLIC_URL: service, STAMP_REPOSITORIES: "acme/project", STAMP_KEY: "a".repeat(32), STAMP_ENROLL_KEY: "b".repeat(32), STAMP_ADMIN_KEY: "c".repeat(32), TABLE_STORAGE_CONNECTION: "test-connection", GITHUB_APP_CLIENT_ID: "test-id", GITHUB_APP_CLIENT_SECRET: "test-secret" }
  const valid = await Effect.runPromise(readServerConfig(env))
  assert.ok(!String(valid.config.adminKey).includes("c".repeat(32)))
  for (const changed of [{ STAMP_PUBLIC_URL: "http://example.com/api/stamp" }, { STAMP_KEY: "weak" }, { STAMP_ADMIN_KEY: env.STAMP_KEY }, { STAMP_REPOSITORIES: "" }]) {
    const error = await Effect.runPromise(readServerConfig({ ...env, ...changed }).pipe(Effect.flip))
    assert.equal(error.code, "service_config")
  }
})
