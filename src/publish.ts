import { Effect, FileSystem, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { ReviewResult, reviewsEndpoint } from "./app-protocol.js"
import type { ReviewRequest } from "./app-protocol.js"
import { checkFindings, readFindings } from "./check.js"
import { oversized, parsePullRequest, renderReview } from "./comment.js"
import { collectSnapshot } from "./context.js"
import { Git } from "./git.js"
import { GitHub } from "./github.js"
import { ReviewError } from "./model.js"

const Sha = Schema.String.check(Schema.makeFilter((value) => /^[a-f0-9]{40}$/.test(value)))
const PullRequest = Schema.Struct({ state: Schema.Literals(["open", "closed"]), head: Schema.Struct({ sha: Sha }), base: Schema.Struct({ sha: Sha }) })
const PullRequestFile = Schema.Struct({ filename: Schema.String, patch: Schema.optional(Schema.String) })

export interface PublishOptions {
  readonly findings: string
  readonly pr: string
  readonly repo: string
  readonly base?: string
  readonly head?: string
  readonly config?: string
  readonly contextFile?: string
  readonly confidence: number
  readonly approve: boolean
  readonly dryRun: boolean
}

const fail = (code: string, message: string) => new ReviewError({ code, message })

const decode = <S extends Schema.Top>(schema: S, value: unknown) => Schema.decodeUnknownEffect(schema)(value).pipe(
  Effect.mapError(() => fail("github_error", "GitHub returned an unexpected response."))
)

/** Sends the key only to the locally trusted service; repository content never chooses the destination. */
const send = Effect.fn("Review.send")(function*(request: ReviewRequest) {
  const configured = process.env.BENEDICT_SERVICE_URL
  if (!configured) return yield* fail("service_auth", "Set BENEDICT_SERVICE_URL to the Benedict service URL for your organization.")
  const endpoint = yield* Effect.try({ try: () => reviewsEndpoint(configured), catch: (error) => fail("service_auth", `BENEDICT_SERVICE_URL is invalid: ${String(error)}`) })
  const key = process.env.BENEDICT_SERVICE_KEY
  if (!key?.trim()) return yield* fail("service_auth", "Set BENEDICT_SERVICE_KEY to the Benedict service key.")
  const result = yield* Effect.gen(function*() {
    const http = yield* HttpClient.HttpClient
    const response = yield* http.execute(HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.setHeader("x-benedict-key", key), HttpClientRequest.bodyJsonUnsafe(request)
    ))
    if (response.status >= 200 && response.status < 300) return yield* response.json
    // A refusal is definite; report the service's reason instead of the generic uncertain-outcome error.
    const refusal = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) }))),
      Effect.orElseSucceed(() => undefined)
    )
    if (refusal && response.status < 500) return yield* Effect.fail(fail(response.status === 401 ? "service_auth" : "publish_refused", `Benedict service refused (HTTP ${response.status}, ${refusal.error.code}): ${refusal.error.message}`))
    return yield* Effect.fail(new Error("Benedict service request failed."))
  }).pipe(
    Effect.timeout("60 seconds"),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.mapError((error) => error instanceof ReviewError ? error : fail("service_error", "Benedict service request failed. The review or approval may have reached GitHub; rerunning the same command is safe because the service detects them. No automatic retry was made."))
  )
  const decoded = yield* Schema.decodeUnknownEffect(ReviewResult)(result).pipe(
    Effect.mapError(() => fail("service_error", "Unexpected Benedict service response; inspect the PR before retrying."))
  )
  if (decoded.pr !== request.pr || decoded.head !== request.head || !decoded.review.url.startsWith(`${request.pr}#pullrequestreview-`)) {
    return yield* fail("service_error", "The Benedict service response does not identify the reviewed PR and commit; inspect the PR.")
  }
  return decoded
})

export const publishReview = Effect.fn("Review.publish")(function*(options: PublishOptions) {
  const target = yield* Effect.try({
    try: () => parsePullRequest(options.pr),
    catch: (error) => fail("input_error", String(error))
  })
  if (!Number.isInteger(options.confidence) || options.confidence < 1 || options.confidence > 5) return yield* fail("input_error", "--confidence must be an integer from 1 to 5.")
  const drafts = yield* readFindings(options.findings)
  const fs = yield* FileSystem.FileSystem
  const context = options.contextFile === undefined ? "" : yield* fs.readFileString(options.contextFile)
  const gh = yield* GitHub
  const git = yield* Git
  const pr = yield* decode(PullRequest, yield* gh.request(`repos/${target.repository}/pulls/${target.number}`))
  if (pr.state !== "open") return yield* fail("pr_closed", "The target PR is closed.")
  const resolveMergeBase = git.run(options.repo, ["merge-base", pr.base.sha, pr.head.sha]).pipe(
    Effect.map((value) => value.trim()),
    Effect.mapError(() => fail("range_error", "Cannot resolve the PR merge base locally. Run benedict context --pr to fetch the PR commits, or fetch them manually, before retrying."))
  )
  const base = options.base ?? (yield* resolveMergeBase)
  const snapshot = yield* collectSnapshot({ repo: options.repo, base, head: options.head, config: options.config, worktree: false })
  const report = yield* checkFindings(snapshot, drafts)
  if (report.range.head !== pr.head.sha) {
    return yield* fail("stale_review", `Reviewed head ${report.range.head} differs from PR head ${pr.head.sha}. Review the current PR head before publishing.`)
  }
  const ancestor = (yield* git.run(snapshot.context.repository, ["merge-base", report.range.base, pr.head.sha])).trim()
  if (ancestor !== report.range.base) return yield* fail("range_error", "Reviewed base must be an ancestor of the PR head.")
  const prMergeBase = options.base === undefined ? base : yield* resolveMergeBase
  const sharedBase = (yield* git.run(snapshot.context.repository, ["merge-base", prMergeBase, report.range.base])).trim()
  if (sharedBase !== prMergeBase) return yield* fail("range_error", "Reviewed base is outside the PR range. Use the PR merge base or a later ancestor of its head.")
  // GitHub's PR patches decide which findings become inline comments, exactly as the service renders them.
  const patches = new Map<string, string>()
  for (let page = 1; page <= 30; page++) {
    const files = yield* decode(Schema.Array(PullRequestFile), yield* gh.request(`repos/${target.repository}/pulls/${target.number}/files?per_page=100&page=${page}`))
    for (const file of files) if (file.patch !== undefined) patches.set(file.filename, file.patch)
    if (files.length < 100) break
  }
  const request: ReviewRequest = {
    version: 1, pr: target.url, base: report.range.base, head: pr.head.sha,
    organizationRevision: report.organization?.revision ?? null,
    findings: report.accepted, dropped: report.summary.rejected,
    confidence: options.confidence, context, approve: options.approve
  }
  const rendered = renderReview(request, target.repository, patches)
  const tooLarge = oversized(rendered)
  if (tooLarge !== undefined) return yield* fail("comment_too_large", `${tooLarge} Shorten findings or context before publishing.`)
  const result = { formatVersion: 1 as const, pr: target.url, range: report.range, organization: report.organization, summary: report.summary, confidence: options.confidence, body: rendered.body, comments: rendered.comments }
  if (options.dryRun) return { ...result, action: "dry-run" as const, reviewUrl: null, postedBy: null, approval: null }
  const posted = yield* send(request)
  return { ...result, action: posted.review.action, reviewUrl: posted.review.url, postedBy: posted.postedBy, approval: posted.approval }
})
