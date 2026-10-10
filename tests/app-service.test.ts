import assert from "node:assert/strict"
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto"
import { test } from "node:test"
import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { appJwt, AppGitHub } from "../src/app-github.js"
import { reviewsEndpoint, serviceError } from "../src/app-protocol.js"
import type { ServiceError } from "../src/app-protocol.js"
import { readServerConfig, serviceRoutes } from "../src/app-server.js"
import { publishAsApp } from "../src/app-service.js"
import { hunkRanges } from "../src/comment.js"

const base = "a".repeat(40), head = "b".repeat(40), later = "c".repeat(40)
const prUrl = "https://github.com/acme/project/pull/7"
const bot = "benedict[bot]"
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const finding = { file: "safe.ts", startLine: 1, endLine: 1, severity: "high", skill: "correctness", title: "Bug", explanation: "Breaks.", quote: "x", confidence: 0.9 }

type ReviewRecord = { state: string; commit_id: string; html_url: string; body: string; user: { login: string } }
type InlineRecord = { path: string; body: string; side: string; line: number; start_line?: number; start_side?: string }
type Write = { method: string; endpoint: string; body: { body: string; event: string; commit_id: string; comments: InlineRecord[] } }

const fixture = () => {
  const state = {
    installed: true,
    pr: { state: "open", draft: false, head: { sha: head }, base: { sha: base }, changed_files: 2 },
    // Merge bases by "from...to" pair; the PR merge base defaults to the base.
    mergeBases: {} as Record<string, string>,
    config: JSON.stringify({ approve: { enabled: true } }) as string | undefined,
    files: [
      { filename: "safe.ts", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-y\n+x" },
      { filename: "other.ts", additions: 2, deletions: 0, patch: "@@ -10,3 +10,5 @@ ctx\n a\n+b\n+c\n d\n e" }
    ] as Array<{ filename: string; additions: number; deletions: number; patch?: string; previous_filename?: string }>,
    reviews: [] as ReviewRecord[],
    writes: [] as Write[],
    rejectApproval: false, loseReview: false, mutateAfterReviews: false
  }
  const gh = AppGitHub.of({
    installation: repository => state.installed && repository === "acme/project"
      ? Effect.succeed({ token: "installation-token", login: bot })
      : Effect.fail(serviceError("repository_disabled", "Not installed.")),
    request: (token, method, endpoint, body) => Effect.suspend<unknown, ServiceError, never>(() => {
      assert.equal(token, "installation-token")
      if (method !== "GET") {
        const payload = body as Write["body"]
        state.writes.push({ method, endpoint, body: payload })
        assert.equal(endpoint, "repos/acme/project/pulls/7/reviews")
        if (state.rejectApproval && payload.event === "APPROVE") return Effect.fail(serviceError("write_rejected", "GitHub refused the write."))
        const review = { state: payload.event === "APPROVE" ? "APPROVED" : "COMMENTED", commit_id: payload.commit_id, html_url: `${prUrl}#pullrequestreview-${90 + state.reviews.length}`, body: payload.body, user: { login: bot } }
        state.reviews.push(review)
        return state.loseReview ? Effect.fail(serviceError("write_uncertain", "Lost response.", 502)) : Effect.succeed(review)
      }
      const compare = /\/compare\/([a-f0-9]+)\.\.\.([a-f0-9]+)$/.exec(endpoint)
      if (compare) return Effect.succeed({ merge_base_commit: { sha: state.mergeBases[`${compare[1]}...${compare[2]}`] ?? compare[1] } })
      if (endpoint.includes("/contents/")) return state.config !== undefined && endpoint.includes("/contents/.benedict/config.json?") ? Effect.succeed({ type: "file", encoding: "base64", content: Buffer.from(state.config).toString("base64"), size: state.config.length }) : Effect.fail(serviceError("github_not_found", "Not found.", 404))
      if (endpoint.includes("/files?")) return Effect.succeed(state.files)
      if (endpoint.includes("/reviews?")) {
        if (state.mutateAfterReviews) state.pr.head.sha = later
        const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"))
        return Effect.succeed(structuredClone(state.reviews.slice((page - 1) * 100, page * 100)))
      }
      return Effect.succeed(structuredClone(state.pr))
    })
  })
  const request = { version: 1, pr: prUrl, base, head, organizationRevision: null as string | null, findings: [] as unknown[], dropped: 2, confidence: 4, context: "Verified the changed path.", approve: true }
  const run = <A, E>(effect: Effect.Effect<A, E, AppGitHub>) => Effect.runPromise(effect.pipe(Effect.provideService(AppGitHub, gh)))
  const publish = () => run(publishAsApp(request))
  const refuse = () => run(publishAsApp(request).pipe(Effect.flip))
  const approvals = () => state.writes.filter(write => write.body.event === "APPROVE")
  return { state, gh, request, run, publish, refuse, approvals }
}

test("the app approves a clean review in one review at the reviewed commit and is idempotent", async () => {
  const f = fixture()
  const result = await f.publish()
  assert.deepEqual(result, {
    pr: prUrl, head, postedBy: bot,
    review: { action: "created", url: `${prUrl}#pullrequestreview-90` },
    approval: { action: "approved", url: `${prUrl}#pullrequestreview-90` }
  })
  const [approval, ...others] = f.state.writes
  assert.equal(others.length, 0)
  assert.equal(approval!.body.event, "APPROVE")
  assert.equal(approval!.body.commit_id, head)
  assert.deepEqual(approval!.body.comments, [])
  assert.ok(approval!.body.body.startsWith("<!-- benedict:review:v1 "))
  assert.match(approval!.body.body, /Overall confidence: \*\*4\/5\*\*/)
  assert.match(approval!.body.body, /Benedict GitHub App posted it/)
  assert.match(approval!.body.body, /Verified the changed path/)
  assert.match(approval!.body.body, /Benedict — automated approval/)
  const again = await f.publish()
  assert.equal(again.review.action, "unchanged")
  assert.equal(again.approval?.action, "already-approved")
  assert.equal(f.state.writes.length, 1)
})

test("each finding becomes its own inline comment, and findings off the diff stay in the summary", async () => {
  const f = fixture()
  f.request.approve = false
  f.request.findings.push(
    finding,
    { ...finding, file: "other.ts", startLine: 11, endLine: 12, title: "Range" },
    // Overlaps the hunk (10-14) only partly.
    { ...finding, file: "other.ts", startLine: 13, endLine: 20, title: "Partial" },
    { ...finding, file: "other.ts", startLine: 40, endLine: 41, title: "Unchanged code", quote: "unchanged" }
  )
  const result = await f.publish()
  assert.deepEqual(result.review, { action: "created", url: `${prUrl}#pullrequestreview-90` })
  assert.equal(result.approval, null)
  const [write] = f.state.writes
  assert.equal(write!.body.event, "COMMENT")
  assert.deepEqual(write!.body.comments.map(({ body, ...anchor }) => anchor), [
    { path: "safe.ts", side: "RIGHT", line: 1 },
    { path: "other.ts", side: "RIGHT", line: 12, start_line: 11, start_side: "RIGHT" },
    { path: "other.ts", side: "RIGHT", line: 14, start_line: 13, start_side: "RIGHT" }
  ])
  assert.match(write!.body.comments[1]!.body, /^### Range\n\n\*\*high · correctness\*\* · confidence 0\.9\n\nBreaks\./)
  assert.match(write!.body.body, /Accepted findings: \*\*4\*\* \(3 inline\)/)
  assert.match(write!.body.body, /### Findings outside the diff\n\n#### 1\. Unchanged code/)
  assert.ok(write!.body.body.includes("/blob/" + head + "/other.ts#L40-L41"))
  assert.ok(!write!.body.body.includes("Partial"))
})

test("every changed review is posted as a new review; an identical rerun is not", async () => {
  const f = fixture()
  f.request.approve = false
  f.state.reviews.push({ state: "COMMENTED", commit_id: head, html_url: `${prUrl}#pullrequestreview-1`, body: "Human review", user: { login: "person" } })
  assert.equal((await f.publish()).review.action, "created")
  assert.equal((await f.publish()).review.action, "unchanged")
  f.request.findings.push(finding)
  assert.deepEqual((await f.publish()).review, { action: "created", url: `${prUrl}#pullrequestreview-92` })
  f.request.context = "Rechecked."
  assert.equal((await f.publish()).review.action, "created")
  assert.equal(f.state.writes.length, 3)
  assert.equal(f.state.reviews[0]!.body, "Human review")
})

test("pagination finds the app's review beyond the first hundred", async () => {
  const f = fixture()
  f.request.approve = false
  await f.publish()
  const own = f.state.reviews.pop()!
  for (let id = 1; id <= 100; id++) f.state.reviews.push({ state: "COMMENTED", commit_id: head, html_url: `${prUrl}#pullrequestreview-${id}`, body: "Discussion", user: { login: "person" } })
  f.state.reviews.push(own)
  assert.equal((await f.publish()).review.action, "unchanged")
  assert.equal(f.state.writes.length, 1)
})

test("approval refusals still publish the review and report the reason", async () => {
  const refusals: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["findings", f => { f.request.findings.push(finding) }],
    ["low_confidence", f => { f.request.confidence = 3 }],
    ["draft", f => { f.state.pr.draft = true }],
    ["partial_review", f => { f.request.base = later; f.state.mergeBases[`${later}...${head}`] = later }],
    ["approve_disabled", f => { f.state.config = JSON.stringify({ approve: { enabled: false } }) }],
    ["approve_disabled", f => { f.state.config = undefined }],
    ["config_error", f => { f.state.config = JSON.stringify({ stamp: { enabled: true } }) }],
    ["config_error", f => { f.state.config = "approve:\n  enabled: true\n" }],
    ["protected_path", f => { f.state.files[0]!.previous_filename = ".agents/skills/benedict/SKILL.md" }],
    ["protected_path", f => { f.state.files[0]!.filename = ".benedict/knowledge.lock.json" }],
    ["protected_path", f => { f.state.config = JSON.stringify({ approve: { enabled: true, denyPaths: ["safe.ts"] } }) }],
    ["size_limit", f => { f.state.files[0]!.additions = 398 }],
    ["coverage", f => { delete f.state.files[0]!.patch }],
    ["coverage", f => { f.state.pr.changed_files = 3 }],
    ["write_rejected", f => { f.state.rejectApproval = true }]
  ]
  for (const [code, mutate] of refusals) {
    const f = fixture()
    mutate(f)
    const result = await f.publish()
    assert.equal(result.review.action, "created", code)
    assert.equal(result.approval?.action === "refused" && result.approval.code, code)
    assert.deepEqual(f.state.reviews.map(review => review.state), ["COMMENTED"], code)
  }
})

test("the request fails without writing for closed PRs, stale or out-of-range reviews and invalid input", async () => {
  const failures: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["repository_disabled", f => { f.state.installed = false }],
    ["pr_closed", f => { f.state.pr.state = "closed" }],
    ["stale_review", f => { f.state.pr.head.sha = later }],
    ["stale_review", f => { f.state.mutateAfterReviews = true }],
    // A base outside the PR: the PR merge base is not an ancestor of it.
    ["range_error", f => { f.request.base = later; f.state.mergeBases[`${base}...${later}`] = "d".repeat(40) }],
    // A base that is not an ancestor of the head.
    ["range_error", f => { f.request.base = later; f.state.mergeBases[`${later}...${head}`] = base }],
    ["invalid_request", f => { f.request.version = 2 }],
    ["invalid_request", f => { f.request.findings.push({ ...finding, extra: true }) }],
    ["invalid_request", f => { f.request.pr = "https://github.com/acme/project/issues/7" }],
    ["invalid_request", f => { (f.request as Record<string, unknown>).stamp = true }],
    ["comment_too_large", f => { f.request.context = "x".repeat(60_000) }],
    ["comment_too_large", f => { f.request.findings.push({ ...finding, explanation: "x".repeat(60_000) }) }]
  ]
  for (const [code, mutate] of failures) {
    const f = fixture()
    mutate(f)
    assert.equal((await f.refuse()).code, code)
    assert.equal(f.state.writes.length, 0, code)
  }
})

test("a narrower range inside the PR publishes but cannot approve", async () => {
  const f = fixture()
  f.request.base = later
  f.state.mergeBases[`${later}...${head}`] = later
  const result = await f.publish()
  assert.equal(result.review.action, "created")
  assert.equal(result.approval?.action === "refused" && result.approval.code, "partial_review")
  assert.match(f.state.reviews[0]!.body, new RegExp(`Reviewed commits: \`${later}\``))
})

test("a PR change between validation and the review write fails closed", async () => {
  const f = fixture()
  let reads = 0
  const changing = AppGitHub.of({
    ...f.gh,
    request: (token, method, endpoint, body) => endpoint === "repos/acme/project/pulls/7" && ++reads === 2
      ? Effect.succeed({ ...f.state.pr, head: { sha: later } })
      : f.gh.request(token, method, endpoint, body)
  })
  const error = await Effect.runPromise(publishAsApp(f.request).pipe(Effect.flip, Effect.provideService(AppGitHub, changing)))
  assert.equal(error.code, "stale_review")
  assert.equal(f.state.writes.length, 0)
})

test("an uncertain review write fails the request, and rerunning finds the review instead of writing again", async () => {
  for (const approve of [true, false]) {
    const f = fixture()
    f.request.approve = approve
    f.state.loseReview = true
    assert.equal((await f.refuse()).code, "write_uncertain")
    f.state.loseReview = false
    const result = await f.publish()
    assert.equal(result.review.action, "unchanged")
    assert.equal(result.approval?.action ?? null, approve ? "already-approved" : null)
    assert.equal(f.state.writes.length, 1)
  }
})

test("a later approval request approves even when the same review was posted without one", async () => {
  const f = fixture()
  f.request.approve = false
  await f.publish()
  f.request.approve = true
  const result = await f.publish()
  assert.equal(result.approval?.action, "approved")
  assert.deepEqual(f.state.reviews.map(review => review.state), ["COMMENTED", "APPROVED"])
})

test("another account's approval does not count, and a dismissed app approval is not renewed", async () => {
  const f = fixture()
  f.state.reviews.push({ state: "APPROVED", commit_id: head, html_url: `${prUrl}#pullrequestreview-1`, body: "", user: { login: "person" } })
  assert.equal((await f.publish()).approval?.action, "approved")
  f.state.reviews[1]!.state = "DISMISSED"
  f.request.context = "Rechecked."
  const result = await f.publish()
  assert.equal(result.approval?.action === "refused" && result.approval.code, "approval_dismissed")
  assert.equal(result.review.action, "created")
  assert.equal(f.approvals().length, 1)
})

test("the reviews route requires the service key and exposes no other operations", async t => {
  const f = fixture()
  const app = Layer.mergeAll(serviceRoutes(Redacted.make("service-key")), Layer.succeed(AppGitHub)(f.gh))
  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true })
  t.after(dispose)
  const call = (path: string, key: string, body?: unknown) => handler(new Request("https://benedict.example.invalid" + path, { method: body ? "POST" : "GET", headers: { "x-benedict-key": key, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }))
  assert.equal((await call("/api/health", "")).status, 200)
  assert.equal((await call("/api/reviews", "wrong-key", f.request)).status, 401)
  for (const path of ["/api/approve", "/api/users"]) assert.equal((await call(path, "service-key", {})).status, 404)
  const invalid = await call("/api/reviews", "service-key", { ...f.request, version: 2 })
  assert.equal(invalid.status, 400)
  assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, "invalid_request")
  const response = await call("/api/reviews", "service-key", { ...f.request, confidence: 3 })
  assert.equal(response.status, 200)
  assert.equal(((await response.json()) as { approval: { code: string } }).approval.code, "low_confidence")
  assert.equal(f.approvals().length, 0)
})

test("service configuration requires a strong key, a numeric app ID and an RSA private key", async () => {
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const env = { BENEDICT_SERVICE_KEY: "a".repeat(32), GITHUB_APP_ID: "12345", GITHUB_APP_PRIVATE_KEY: pem }
  const valid = await Effect.runPromise(readServerConfig(env))
  assert.equal(valid.appId, "12345")
  assert.ok(!String(valid.serviceKey).includes("a".repeat(32)))
  // Secret managers commonly store PEM newlines escaped.
  await Effect.runPromise(readServerConfig({ ...env, GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n") }))
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  for (const changed of [{ BENEDICT_SERVICE_KEY: "weak" }, { GITHUB_APP_ID: "benedict" }, { GITHUB_APP_PRIVATE_KEY: "not a key" }, { GITHUB_APP_PRIVATE_KEY: ec }, { GITHUB_APP_ID: "" }]) {
    const error = await Effect.runPromise(readServerConfig({ ...env, ...changed }).pipe(Effect.flip))
    assert.equal(error.code, "service_config")
  }
})

test("service URLs resolve the reviews endpoint and cannot carry credentials or use HTTP", () => {
  assert.equal(reviewsEndpoint("https://benedict.example.com"), "https://benedict.example.com/api/reviews")
  assert.equal(reviewsEndpoint("https://example.com/benedict/"), "https://example.com/benedict/api/reviews")
  for (const value of ["http://example.com", "https://user:password@example.com", "https://example.com?key=secret", "https://example.com#fragment"]) {
    assert.throws(() => reviewsEndpoint(value))
  }
})

test("app JWTs are RS256-signed by the app with a bounded lifetime", () => {
  const [header, payload, signature] = appJwt("12345", privateKey, 1_000_000).split(".")
  assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "RS256", typ: "JWT" })
  assert.deepEqual(JSON.parse(Buffer.from(payload!, "base64url").toString()), { iat: 999_940, exp: 1_000_540, iss: "12345" })
  assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), createPublicKey(privateKey), Buffer.from(signature!, "base64url")))
})

test("installation tokens are scoped to the repository, and write outcomes are classified", async () => {
  const calls: Array<{ url: string; method: string; authorization: string | null; body: unknown }> = []
  let respond = (url: string): Response => url.endsWith("/installation") ? Response.json({ id: 9, app_slug: "benedict" }) : Response.json({ token: "scoped-token" })
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const text = await request.text()
    calls.push({ url: request.url, method: request.method, authorization: request.headers.get("authorization"), body: text ? JSON.parse(text) : undefined })
    return respond(request.url)
  }) as typeof fetch
  const run = <A, E>(use: (gh: AppGitHub["Service"]) => Effect.Effect<A, E>) => Effect.runPromise(Effect.flatMap(AppGitHub, use).pipe(
    Effect.provide(AppGitHub.layer("12345", privateKey).pipe(Layer.provide(FetchHttpClient.layer))),
    Effect.provideService(FetchHttpClient.Fetch, fakeFetch)
  ))
  const installation = await run(gh => gh.installation("acme/project"))
  assert.deepEqual(installation, { token: "scoped-token", login: "benedict[bot]" })
  assert.equal(calls[0]?.url, "https://api.github.com/repos/acme/project/installation")
  assert.equal(calls[1]?.url, "https://api.github.com/app/installations/9/access_tokens")
  assert.deepEqual(calls[1]?.body, { repositories: ["project"], permissions: { pull_requests: "write", contents: "read" } })
  assert.match(calls[1]!.authorization!, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)

  respond = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })
  assert.equal((await run(gh => gh.installation("acme/other").pipe(Effect.flip))).code, "repository_disabled")
  respond = () => new Response(JSON.stringify({ message: "Can not approve your own pull request" }), { status: 422 })
  const rejected = await run(gh => gh.request("t", "POST", "repos/acme/project/pulls/7/reviews", {}).pipe(Effect.flip))
  assert.equal(rejected.code, "write_rejected")
  assert.match(rejected.message, /Can not approve your own pull request/)
  respond = () => new Response("{}", { status: 502 })
  assert.equal((await run(gh => gh.request("t", "POST", "repos/acme/project/pulls/7/reviews", {}).pipe(Effect.flip))).code, "write_uncertain")
  assert.equal((await run(gh => gh.request("t", "GET", "repos/acme/project/pulls/7").pipe(Effect.flip))).code, "github_unavailable")
})

test("hunk ranges cover head-side context and added lines", () => {
  assert.deepEqual(hunkRanges("@@ -1 +1 @@\n-a\n+b\n@@ -10,2 +12,4 @@ fn\n x\n+y\n+z\n w\n@@ -30,3 +33,0 @@\n-gone"), [[1, 1], [12, 15]])
})
