import assert from "node:assert/strict"
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto"
import { test } from "node:test"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { commentMarker } from "../src/publish.js"
import { approveStamp } from "../src/stamp-service.js"
import { appJwt, StampGitHub } from "../src/stamp-github.js"
import { publishedConfidence, stampError } from "../src/stamp-protocol.js"
import type { StampError } from "../src/stamp-protocol.js"
import { readServerConfig, stampRoutes } from "../src/stamp-server.js"

const base = "a".repeat(40), head = "b".repeat(40)
const prUrl = "https://github.com/acme/project/pull/7"
const service = "https://stamp.example.invalid/api/stamp"
const bot = "review-agent[bot]"
const reviewBody = (confidence = "**Confidence: 4/5**", range = `\`${base}\` → \`${head}\``, accepted = 0) =>
  `${commentMarker}\n## AI-generated review\n\nReviewed commits: ${range}.\n\nAccepted findings: **${accepted}**. Dropped drafts: **2**.\n\n### Review context\n\n${confidence}\n\nVerified the changed path.\n`
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })

type ReviewRecord = { state: string; commit_id: string; html_url: string; user: { id: number; login: string } }

const fixture = () => {
  const state = {
    installed: true,
    pr: { state: "open", draft: false, head: { sha: head }, base: { sha: base }, user: { id: 1, login: "author" }, changed_files: 1 },
    mergeBase: base,
    config: JSON.stringify({ stamp: { enabled: true, service } }),
    files: [{ filename: "safe.ts", additions: 1, deletions: 1, patch: "@@ ..." }] as Array<{ filename: string; additions: number; deletions: number; patch?: string; previous_filename?: string }>,
    comment: { body: reviewBody(), issue_url: "https://api.github.com/repos/acme/project/issues/7" } as { body: string; issue_url: string } | undefined,
    reviews: [] as ReviewRecord[],
    writes: [] as Array<{ token: string; endpoint: string; body: { commit_id: string; body: string; event: string } }>,
    rejectWrite: false, unknownWrite: false, mutateAfterReviews: false
  }
  const gh = StampGitHub.of({
    installation: repository => state.installed && repository === "acme/project"
      ? Effect.succeed({ token: "installation-token", login: bot })
      : Effect.fail(stampError("repository_disabled", "Not installed.")),
    request: (token, method, endpoint, body) => Effect.suspend<unknown, StampError, never>(() => {
      assert.equal(token, "installation-token")
      if (method === "POST") {
        const payload = body as { commit_id: string; body: string; event: string }
        state.writes.push({ token, endpoint, body: payload })
        if (state.rejectWrite) return Effect.fail(stampError("review_rejected", "GitHub refused the approval."))
        const review = { state: "APPROVED", commit_id: payload.commit_id, html_url: prUrl + "#pullrequestreview-99", user: { id: 900, login: bot } }
        state.reviews.push(review)
        return state.unknownWrite ? Effect.fail(stampError("write_uncertain", "Lost response.", 502)) : Effect.succeed(review)
      }
      if (endpoint.includes("/compare/")) return Effect.succeed({ merge_base_commit: { sha: state.mergeBase } })
      if (endpoint.includes("/contents/")) return endpoint.includes("/contents/.review/config.json?") ? Effect.succeed({ type: "file", encoding: "base64", content: Buffer.from(state.config).toString("base64"), size: state.config.length }) : Effect.fail(stampError("github_not_found", "Not found.", 404))
      if (endpoint.includes("/files?")) return Effect.succeed(state.files)
      if (endpoint.includes("/issues/comments/55")) return state.comment ? Effect.succeed(state.comment) : Effect.fail(stampError("github_not_found", "Not found.", 404))
      if (endpoint.includes("/reviews?")) { if (state.mutateAfterReviews) state.pr.head.sha = "c".repeat(40); return Effect.succeed(state.reviews) }
      return Effect.succeed(structuredClone(state.pr))
    })
  })
  const report = { version: 2, pr: prUrl, base, head, findings: [] as unknown[], dropped: 2, skills: ["correctness", "security"], confidence: 4, reviewComment: `${prUrl}#issuecomment-55` }
  const run = <A, E>(effect: Effect.Effect<A, E, StampGitHub>) => Effect.runPromise(effect.pipe(Effect.provideService(StampGitHub, gh)))
  const approve = () => run(approveStamp(report, service))
  const refuse = () => run(approveStamp(report, service).pipe(Effect.flip))
  return { state, gh, report, run, approve, refuse }
}

test("the GitHub App approves the reviewed commit with AI attribution and is idempotent", async () => {
  const f = fixture()
  const result = await f.approve()
  assert.deepEqual(result, { action: "approved", pr: prUrl, head, approvedBy: bot, reviewUrl: prUrl + "#pullrequestreview-99" })
  const write = f.state.writes[0]!
  assert.equal(write.endpoint, "repos/acme/project/pulls/7/reviews")
  assert.equal(write.body.event, "APPROVE")
  assert.equal(write.body.commit_id, head)
  assert.match(write.body.body, /Review Agent — automated approval/)
  assert.match(write.body.body, /overall confidence: 4\/5/)
  assert.ok(write.body.body.includes(`${prUrl}#issuecomment-55`))
  assert.equal((await f.approve()).action, "already-approved")
  assert.equal(f.state.writes.length, 1)
})

test("rerunning after an uncertain write finds the approval instead of writing again", async () => {
  const f = fixture()
  f.state.unknownWrite = true
  assert.equal((await f.refuse()).code, "write_uncertain")
  f.state.unknownWrite = false
  assert.equal((await f.approve()).action, "already-approved")
  assert.equal(f.state.writes.length, 1)
})

test("another account's approval does not count as the Review Agent stamp", async () => {
  const f = fixture()
  f.state.reviews.push({ state: "APPROVED", commit_id: head, html_url: prUrl + "#pullrequestreview-1", user: { id: 2, login: "person" } })
  assert.equal((await f.approve()).action, "approved")
  assert.equal(f.state.writes.length, 1)
})

test("an explicit GitHub refusal is reported as a refusal", async () => {
  const f = fixture()
  f.state.rejectWrite = true
  const error = await f.refuse()
  assert.equal(error.code, "review_rejected")
  assert.equal(error.status, 409)
})

test("a dismissed Review Agent approval is not silently reapproved", async () => {
  const f = fixture()
  await f.approve()
  f.state.reviews[0]!.state = "DISMISSED"
  assert.equal((await f.refuse()).code, "stamp_dismissed")
  assert.equal(f.state.writes.length, 1)
})

test("the service rechecks findings, confidence, installation, whole-PR range, policy and the published review", async () => {
  const mutations: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["findings", f => { f.report.findings.push({ title: "bug" }) }],
    ["low_confidence", f => { f.report.confidence = 3 }],
    ["repository_disabled", f => { f.state.installed = false }],
    ["stale_review", f => { f.state.pr.head.sha = "c".repeat(40) }],
    ["partial_review", f => { f.state.mergeBase = "c".repeat(40) }],
    ["stamp_refused", f => { f.state.pr.draft = true }],
    ["stamp_refused", f => { f.state.config = JSON.stringify({ stamp: { enabled: false, service } }) }],
    ["stamp_refused", f => { f.state.config = JSON.stringify({ stamp: { enabled: true, service: "https://other.example.invalid/api/stamp" } }) }],
    ["config_error", f => { f.state.config = `stamp:\n  enabled: true\n  service: ${service}\n` }],
    ["protected_path", f => { f.state.files[0]!.previous_filename = ".agents/skills/review/SKILL.md" }],
    ["protected_path", f => { f.state.files[0]!.filename = ".review/knowledge.lock.json" }],
    ["size_limit", f => { f.state.files[0]!.additions = 401 }],
    ["coverage", f => { delete f.state.files[0]!.patch }],
    ["review_missing", f => { f.state.comment = undefined }],
    ["review_missing", f => { f.state.comment!.issue_url = "https://api.github.com/repos/acme/project/issues/8" }],
    ["invalid_report", f => { f.report.reviewComment = "https://github.com/acme/project/pull/8#issuecomment-55" }],
    ["review_mismatch", f => { f.report.confidence = 5 }],
    ["review_mismatch", f => { f.state.comment!.body = reviewBody("**Confidence: 4/5**", `\`${base}\` → \`${"c".repeat(40)}\``) }],
    ["review_mismatch", f => { f.state.comment!.body = reviewBody("**Confidence: 4/5**", undefined, 1) }],
    ["stale_review", f => { f.state.mutateAfterReviews = true }]
  ]
  for (const [code, mutate] of mutations) {
    const f = fixture()
    mutate(f)
    assert.equal((await f.refuse()).code, code)
    assert.equal(f.state.writes.length, 0)
  }
  const f = fixture()
  assert.equal((await f.run(approveStamp({ ...f.report, version: 1 }, service).pipe(Effect.flip))).code, "invalid_report")
})

test("published confidence must be one score for the exact clean range", () => {
  assert.equal(publishedConfidence(reviewBody(), base, head), 4)
  assert.equal(publishedConfidence(reviewBody("Confidence: 5/5 — strong evidence"), base, head), 5)
  assert.equal(publishedConfidence(reviewBody("**Confidence: 4/5**\n\nConfidence: 2/5"), base, head), undefined)
  assert.equal(publishedConfidence(reviewBody("No score."), base, head), undefined)
  assert.equal(publishedConfidence(reviewBody(), base, "c".repeat(40)), undefined)
  assert.equal(publishedConfidence(reviewBody().replace(commentMarker, "<!-- other -->"), base, head), undefined)
})

test("the approval route requires the stamp key and exposes no other operations", async t => {
  const f = fixture()
  const app = Layer.mergeAll(stampRoutes({ service, stampKey: Redacted.make("stamp-key") }), Layer.succeed(StampGitHub)(f.gh))
  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true })
  t.after(dispose)
  const call = (path: string, key: string, body?: unknown) => handler(new Request("https://stamp.example.invalid" + path, { method: body ? "POST" : "GET", headers: { "x-review-key": key, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }))
  assert.equal((await call("/api/health", "")).status, 200)
  assert.equal((await call("/api/stamp", "wrong-key", f.report)).status, 401)
  for (const path of ["/api/enroll/start", "/api/users"]) assert.equal((await call(path, "stamp-key", {})).status, 404)
  const refused = await call("/api/stamp", "stamp-key", { ...f.report, confidence: 3 })
  assert.equal(refused.status, 409)
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "low_confidence")
  assert.equal((await call("/api/stamp", "stamp-key", f.report)).status, 200)
  assert.equal(f.state.writes.length, 1)
})

test("service configuration requires HTTPS, a strong key, a numeric app ID and an RSA private key", async () => {
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const env = { STAMP_PUBLIC_URL: service, STAMP_KEY: "a".repeat(32), GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: pem }
  const valid = await Effect.runPromise(readServerConfig(env))
  assert.equal(valid.appId, "12345")
  assert.ok(!String(valid.config.stampKey).includes("a".repeat(32)))
  // Secret managers commonly store PEM newlines escaped.
  await Effect.runPromise(readServerConfig({ ...env, GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n") }))
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  for (const changed of [{ STAMP_PUBLIC_URL: "http://example.com/api/stamp" }, { STAMP_KEY: "weak" }, { GITHUB_APP_ID: "review-agent" }, { GITHUB_APP_PRIVATE_KEY: "not a key" }, { GITHUB_APP_PRIVATE_KEY: ec }, { GITHUB_APP_ID: "" }]) {
    const error = await Effect.runPromise(readServerConfig({ ...env, ...changed }).pipe(Effect.flip))
    assert.equal(error.code, "service_config")
  }
})

test("app JWTs are RS256-signed by the app with a bounded lifetime", () => {
  const [header, payload, signature] = appJwt("12345", privateKey, 1_000_000).split(".")
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "RS256", typ: "JWT" })
  assert.deepEqual(JSON.parse(Buffer.from(payload!, "base64url").toString()), { iat: 999_940, exp: 1_000_540, iss: "12345" })
  assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), createPublicKey(privateKey), Buffer.from(signature!, "base64url")))
})

test("installation tokens are scoped to the stamped repository, and write outcomes are classified", async () => {
  const calls: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = []
  let respond = (url: string): Response => url.endsWith("/installation") ? Response.json({ id: 9, app_slug: "review-agent" }) : Response.json({ token: "scoped-token" })
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const text = await request.text()
    calls.push({ url: request.url, method: request.method, authorization: request.headers.get("authorization"), body: text ? JSON.parse(text) : undefined })
    return respond(request.url)
  }) as typeof fetch
  const run = <A, E>(use: (gh: StampGitHub["Service"]) => Effect.Effect<A, E>) => Effect.runPromise(Effect.flatMap(StampGitHub, use).pipe(
    Effect.provide(StampGitHub.layer("12345", privateKey).pipe(Layer.provide(FetchHttpClient.layer))),
    Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
  ))
  const installation = await run(gh => gh.installation("acme/project"))
  assert.deepEqual(installation, { token: "scoped-token", login: "review-agent[bot]" })
  assert.equal(calls[0]?.url, "https://api.github.com/repos/acme/project/installation")
  assert.equal(calls[1]?.url, "https://api.github.com/app/installations/9/access_tokens")
  assert.deepEqual(calls[1]?.body, { repositories: ["project"], permissions: { pull_requests: "write", contents: "read" } })
  assert.match(calls[1]!.authorization!, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)

  respond = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
  assert.equal((await run(gh => gh.installation("acme/other").pipe(Effect.flip))).code, "repository_disabled")
  respond = () => new Response(JSON.stringify({ message: "Can not approve your own pull request" }), { status: 422 })
  const rejected = await run(gh => gh.request("t", "POST", "repos/acme/project/pulls/7/reviews", {}).pipe(Effect.flip))
  assert.equal(rejected.code, "review_rejected")
  assert.match(rejected.message, /Can not approve your own pull request/)
  respond = () => new Response("{}", { status: 502 })
  assert.equal((await run(gh => gh.request("t", "POST", "repos/acme/project/pulls/7/reviews", {}).pipe(Effect.flip))).code, "write_uncertain")
})
