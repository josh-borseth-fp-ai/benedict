import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import picomatch from "picomatch"
import { checkFindings, readFindings } from "./check.js"
import { collectSnapshot } from "./context.js"
import { Git } from "./git.js"
import { GitHub } from "./github.js"
import { ConfigFile, ReviewError, configPath } from "./model.js"
import { parseJson } from "./policy.js"
import { parsePullRequest } from "./publish.js"
import { protectedPaths, serviceUrl } from "./stamp-protocol.js"
export { serviceUrl } from "./stamp-protocol.js"

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
const Pr = Schema.Struct({
  state: Schema.String, draft: Schema.Boolean,
  head: Schema.Struct({ sha: Sha }), base: Schema.Struct({ sha: Sha })
})
const Response = Schema.Struct({
  action: Schema.Literals(["approved", "already-approved"]),
  pr: Schema.String, head: Sha, approvedBy: Schema.String, reviewUrl: Schema.String
})

export interface StampOptions {
  readonly repo: string
  readonly base: string
  readonly head: string
  readonly config?: string
  readonly findings: string
  readonly pr: string
  readonly dryRun: boolean
}

const fail = (code: string, message: string) => new ReviewError({ code, message })

export const stampReview = Effect.fn("Review.stamp")(function*(options: StampOptions) {
  const target = yield* Effect.try({ try: () => parsePullRequest(options.pr), catch: (e) => fail("input_error", String(e)) })
  const drafts = yield* readFindings(options.findings)
  const snapshot = yield* collectSnapshot({ ...options, worktree: false })
  const report = yield* checkFindings(snapshot, drafts)
  if (report.accepted.length > 0) return yield* fail("stamp_refused", "The review has accepted findings; resolve them before stamping.")
  const gh = yield* GitHub
  const git = yield* Git
  const endpoint = `repos/${target.repository}/pulls/${target.number}`
  const readPr = () => gh.request("GET", endpoint).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Pr)),
    Effect.mapError(() => fail("github_error", "Cannot read the PR metadata. No stamp was sent."))
  )
  const pr = yield* readPr()
  const root = snapshot.context.repository
  const mergeBase = (yield* git.run(root, ["merge-base", pr.base.sha, pr.head.sha])).trim()
  if (pr.state !== "open" || pr.draft) return yield* fail("stamp_refused", "Stamping requires an open, non-draft PR.")
  if (report.range.base !== mergeBase || report.range.head !== pr.head.sha) {
    return yield* fail("stale_review", "Stamping requires a review of the current whole PR, from its merge base through its head.")
  }
  // Read stamping authorization and destination from GitHub's base commit, never from the PR or worktree.
  const entry = yield* git.run(root, ["ls-tree", pr.base.sha, "--", configPath])
  if (!/^100(644|755) blob /.test(entry)) return yield* fail("stamp_refused", `The base branch must have ${configPath} with stamping enabled.`)
  const parsed = yield* parseJson(yield* git.run(root, ["show", `${pr.base.sha}:${configPath}`]), configPath)
  const config = yield* Schema.decodeUnknownEffect(ConfigFile, { onExcessProperty: "error" })(parsed).pipe(
    Effect.mapError(() => fail("config_error", "The base branch review config is invalid."))
  )
  const stamp = config.stamp
  if (!stamp?.enabled || !stamp.service) return yield* fail("stamp_refused", "Set stamp.enabled and stamp.service on the base branch.")
  const service = yield* Effect.try({ try: () => serviceUrl(stamp.service!), catch: (e) => fail("config_error", String(e)) })
  // --no-renames includes both ends of a rename when checking protected paths and line limits.
  const numstat = yield* git.run(root, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--no-renames", mergeBase, pr.head.sha])
  let changedLines = 0
  for (const row of numstat.split("\0").filter(Boolean)) {
    const [added, deleted, ...parts] = row.split("\t")
    const path = parts.join("\t")
    if (!path || !added || !deleted) return yield* fail("git_error", "Unexpected Git numstat output.")
    if (added === "-" || deleted === "-") return yield* fail("stamp_refused", `Binary change requires manual review: ${path}`)
    changedLines += Number(added) + Number(deleted)
    const blocked = [...protectedPaths, ...(stamp.denyPaths ?? [])].find(pattern => picomatch.isMatch(path, pattern, { dot: true, strictBrackets: true }))
    if (blocked) return yield* fail("stamp_refused", `The PR changes ${path}, protected by ${blocked}.`)
  }
  if (changedLines > (stamp.maxChangedLines ?? 400)) return yield* fail("stamp_refused", "The PR exceeds stamp.maxChangedLines.")
  const request = {
    version: 1, pr: target.url, base: mergeBase, head: pr.head.sha,
    findings: report.accepted, dropped: report.summary.rejected,
    skills: snapshot.context.config.skills
  }
  if (options.dryRun) return { action: "dry-run" as const, pr: target.url, head: pr.head.sha, service, request, reviewUrl: null }
  // A repository can authorize stamping, but cannot choose the destination for a locally configured secret.
  const trustedService = process.env.REVIEW_STAMP_URL
  if (!trustedService) return yield* fail("stamp_auth", "Set REVIEW_STAMP_URL to the trusted stamp endpoint for your service key.")
  const trustedUrl = yield* Effect.try({ try: () => serviceUrl(trustedService), catch: () => fail("stamp_auth", "REVIEW_STAMP_URL must be a valid HTTPS stamp endpoint.") })
  if (trustedUrl !== service) return yield* fail("stamp_auth", "The base branch stamp.service does not match the locally trusted REVIEW_STAMP_URL. No key was sent.")
  const key = process.env.REVIEW_STAMP_KEY
  if (!key?.trim()) return yield* fail("stamp_auth", "Set REVIEW_STAMP_KEY to the shared service's stamp key.")
  const current = yield* readPr()
  if (current.state !== pr.state || current.draft || current.head.sha !== pr.head.sha || current.base.sha !== pr.base.sha) {
    return yield* fail("stale_review", "The PR changed before stamping. Review its current range.")
  }
  const result = yield* Effect.gen(function*() {
    const http = yield* HttpClient.HttpClient
    const response = yield* http.execute(HttpClientRequest.post(service).pipe(
      HttpClientRequest.setHeader("x-review-key", key), HttpClientRequest.bodyJsonUnsafe(request)
    ))
    if (response.status < 200 || response.status >= 300) return yield* Effect.fail(new Error("Stamp request refused."))
    return yield* response.json
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.mapError(() => fail("stamp_service_error", "Stamp service request failed. An approval may have reached GitHub; inspect the PR before retrying. No automatic retry was made."))
  )
  const decoded = yield* Schema.decodeUnknownEffect(Response)(result).pipe(
    Effect.mapError(() => fail("stamp_service_error", "Unexpected stamp service response; inspect the PR before retrying."))
  )
  if (decoded.pr !== target.url || decoded.head !== pr.head.sha || !decoded.reviewUrl.startsWith(`${target.url}#pullrequestreview-`)) {
    return yield* fail("stamp_service_error", "Stamp response does not identify the reviewed PR and commit; inspect the PR.")
  }
  return decoded
})
