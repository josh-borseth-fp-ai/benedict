import { Effect, Schema } from "effect"
import picomatch from "picomatch"
import { AppGitHub } from "./app-github.js"
import { minimumConfidence, protectedPaths, ReviewRequest, serviceError, Sha } from "./app-protocol.js"
import type { ApprovalOutcome, ReviewResult } from "./app-protocol.js"
import { oversized, parsePullRequest, renderReview, reviewMarker } from "./comment.js"
import type { RenderedReview } from "./comment.js"
import { ConfigFile, configPath } from "./model.js"
import { parseJson } from "./policy.js"

const Identity = Schema.Struct({ login: Schema.String })
const Pr = Schema.Struct({ state: Schema.String, draft: Schema.Boolean, head: Schema.Struct({ sha: Sha }), base: Schema.Struct({ sha: Sha }), changed_files: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })
type Pr = typeof Pr.Type
const File = Schema.Struct({ filename: Schema.String, previous_filename: Schema.optional(Schema.String), additions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), deletions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), patch: Schema.optional(Schema.String) })
type File = typeof File.Type
const Review = Schema.Struct({ state: Schema.String, commit_id: Schema.NullOr(Sha), html_url: Schema.String, body: Schema.NullOr(Schema.String), user: Schema.NullOr(Identity) })
type Review = typeof Review.Type
const Comparison = Schema.Struct({ merge_base_commit: Schema.Struct({ sha: Sha }) })

interface Target {
  readonly token: string
  readonly login: string
  readonly repository: string
  readonly number: number
  readonly url: string
}

const decode = <S extends Schema.Top>(schema: S, value: unknown) => Schema.decodeUnknownEffect(schema)(value).pipe(
  Effect.mapError(() => serviceError("invalid_response", "The Benedict service received an invalid GitHub response.", 502))
)
const signature = (pr: Pr) => [pr.state, pr.draft, pr.head.sha, pr.base.sha].join(":")

const pages = Effect.fn("App.pages")(function*<S extends Schema.Top>(token: string, endpoint: string, schema: S, maxPages = 100) {
  const gh = yield* AppGitHub
  const items: Array<S["Type"]> = []
  for (let page = 1; page <= maxPages; page++) {
    const batch = yield* decode(Schema.Array(schema), yield* gh.request(token, "GET", `${endpoint}?per_page=100&page=${page}`))
    items.push(...batch)
    if (batch.length < 100) return items
  }
  return yield* serviceError("coverage", "Cannot inspect all GitHub pages; manual review is required.")
})

const mergeBase = Effect.fn("App.mergeBase")(function*(target: Target, base: string, head: string) {
  const gh = yield* AppGitHub
  return (yield* decode(Comparison, yield* gh.request(target.token, "GET", `repos/${target.repository}/compare/${base}...${head}`))).merge_base_commit.sha
})

const readPr = Effect.fn("App.readPr")(function*(target: Target) {
  const gh = yield* AppGitHub
  return yield* decode(Pr, yield* gh.request(target.token, "GET", `repos/${target.repository}/pulls/${target.number}`))
})

const checkPolicy = Effect.fn("App.checkPolicy")(function*(target: Target, pr: Pr, files: ReadonlyArray<File>) {
  const gh = yield* AppGitHub
  const value = yield* gh.request(target.token, "GET", `repos/${target.repository}/contents/${configPath}?ref=${pr.base.sha}`).pipe(
    Effect.mapError((error) => error.code === "github_not_found" ? serviceError("approve_disabled", `The base branch must have ${configPath} with approve.enabled.`) : error)
  )
  const content = yield* decode(Schema.Struct({ type: Schema.Literal("file"), encoding: Schema.Literal("base64"), content: Schema.String, size: Schema.Int }), value)
  if (content.size > 100_000) return yield* serviceError("config_error", "The base config is too large.")
  const parsed = yield* parseJson(Buffer.from(content.content, "base64").toString("utf8"), configPath).pipe(Effect.mapError(() => serviceError("config_error", "The base review config is invalid.")))
  const config = yield* Schema.decodeUnknownEffect(ConfigFile, { onExcessProperty: "error" })(parsed).pipe(
    Effect.mapError(() => serviceError("config_error", "The base review config is invalid."))
  )
  const approve = config.approve
  if (!approve?.enabled) return yield* serviceError("approve_disabled", "The base branch does not enable approval.")
  if (pr.changed_files > 3000 || files.length !== pr.changed_files) return yield* serviceError("coverage", "Changed-file coverage is incomplete.")
  let lines = 0
  for (const file of files) {
    if (file.patch === undefined) return yield* serviceError("coverage", "A changed file has no text patch; manual review is required.")
    for (const name of [file.filename, file.previous_filename].filter((name): name is string => name !== undefined)) {
      const protectedPath = [...protectedPaths, ...(approve.denyPaths ?? [])].some(pattern => picomatch.isMatch(name, pattern, { dot: true, strictBrackets: true }))
      if (protectedPath) return yield* serviceError("protected_path", `A protected path changed: ${name}.`)
    }
    lines += file.additions + file.deletions
  }
  if (lines > (approve.maxChangedLines ?? 400)) return yield* serviceError("size_limit", "The PR exceeds approve.maxChangedLines.")
})

/** Decides whether this review may approve. GitHub's review list, not a database, makes repeated requests idempotent. */
const approvalDecision = Effect.fn("App.approvalDecision")(function*(target: Target, pr: Pr, prMergeBase: string, review: ReviewRequest, files: ReadonlyArray<File>, ours: ReadonlyArray<Review>) {
  if (review.findings.length > 0) return yield* serviceError("findings", "Accepted findings must be resolved before approval.")
  if (review.confidence < minimumConfidence) return yield* serviceError("low_confidence", `Overall confidence ${review.confidence}/5 is below ${minimumConfidence}/5; request human review.`)
  if (pr.draft) return yield* serviceError("draft", "Approval requires a non-draft PR.")
  if (review.base !== prMergeBase) return yield* serviceError("partial_review", "Approval requires a review of the whole PR from its merge base.")
  yield* checkPolicy(target, pr, files)
  const approved = ours.find(item => item.state === "APPROVED")
  if (approved) return { action: "already-approved", url: approved.html_url } satisfies ApprovalOutcome
  if (ours.some(item => item.state === "DISMISSED")) return yield* serviceError("approval_dismissed", "The Benedict approval for this commit was dismissed; a person must approve it.")
  return "approve" as const
})

/** Submits one GitHub review at the reviewed head: the summary body and one inline comment per anchored finding. */
const submitReview = Effect.fn("App.submitReview")(function*(target: Target, head: string, event: "APPROVE" | "COMMENT", rendered: RenderedReview) {
  const gh = yield* AppGitHub
  const body = event === "APPROVE"
    ? `${rendered.body}\n🤖 **Benedict — automated approval.** The Benedict GitHub App approved commit \`${head}\` because this review has no accepted findings. Branch rules decide whether it satisfies merge requirements.\n`
    : rendered.body
  const comments = rendered.comments.map(comment => ({
    path: comment.path, body: comment.body, side: "RIGHT", line: comment.line,
    ...(comment.startLine === comment.line ? {} : { start_line: comment.startLine, start_side: "RIGHT" })
  }))
  const written = yield* Effect.uninterruptible(gh.request(target.token, "POST", `repos/${target.repository}/pulls/${target.number}/reviews`, { event, commit_id: head, body, comments }).pipe(
    Effect.flatMap(raw => decode(Review, raw))
  ))
  if (written.state !== (event === "APPROVE" ? "APPROVED" : "COMMENTED") || written.commit_id !== head || written.user?.login !== target.login || !written.html_url.startsWith(`${target.url}#pullrequestreview-`)) {
    return yield* serviceError("write_uncertain", "GitHub returned an unexpected review; inspect the PR.", 502)
  }
  return written.html_url
})

/**
 * Posts a locally completed review as a new Benedict GitHub App review and, when requested, approves with it.
 * The service trusts the caller's review; it renders the review itself and checks the PR range.
 */
export const publishAsApp = Effect.fn("App.publish")(function*(value: unknown) {
  const review = yield* Schema.decodeUnknownEffect(ReviewRequest, { onExcessProperty: "error" })(value).pipe(Effect.mapError(() => serviceError("invalid_request", "Invalid version-1 review request.", 400)))
  const pull = yield* Effect.try({ try: () => parsePullRequest(review.pr), catch: () => serviceError("invalid_request", "Use a full GitHub PR URL.", 400) })
  const gh = yield* AppGitHub
  const target: Target = { ...pull, ...(yield* gh.installation(pull.repository)) }
  const pr = yield* readPr(target)
  if (pr.state !== "open") return yield* serviceError("pr_closed", "The PR is closed.")
  if (pr.head.sha !== review.head) return yield* serviceError("stale_review", "The review is stale; review the current PR head.")
  const prMergeBase = yield* mergeBase(target, pr.base.sha, review.head)
  if (review.base !== prMergeBase && ((yield* mergeBase(target, prMergeBase, review.base)) !== prMergeBase || (yield* mergeBase(target, review.base, review.head)) !== review.base)) {
    return yield* serviceError("range_error", "The reviewed base must be the PR merge base or a later ancestor of its head.")
  }
  const files = yield* pages(target.token, `repos/${target.repository}/pulls/${target.number}/files`, File, 31)
  const rendered = renderReview(review, pull.repository, new Map(files.flatMap(file => file.patch === undefined ? [] : [[file.filename, file.patch] as const])))
  const tooLarge = oversized(rendered)
  if (tooLarge !== undefined) return yield* serviceError("comment_too_large", tooLarge, 400)
  const ours = (yield* pages(target.token, `repos/${target.repository}/pulls/${target.number}/reviews`, Review))
    .filter(item => item.user?.login === target.login && item.commit_id === review.head)
  // A definite refusal is reported next to the posted review instead of failing the request.
  let approval: ApprovalOutcome | "approve" | null = review.approve
    ? yield* approvalDecision(target, pr, prMergeBase, review, files, ours).pipe(
      Effect.catchIf(error => error.status < 500, error => Effect.succeed({ action: "refused", code: error.code, message: error.message } satisfies ApprovalOutcome))
    )
    : null
  const result = (action: "created" | "unchanged", url: string, outcome: ApprovalOutcome | null) =>
    ({ pr: target.url, head: review.head, postedBy: target.login, review: { action, url }, approval: outcome }) satisfies ReviewResult
  if (approval !== "approve") {
    // Rerunning the same review, for example after a timeout, finds the review that landed.
    const existing = ours.find(item => item.body?.startsWith(`${reviewMarker(review)}\n`))
    if (existing) return result("unchanged", existing.html_url, approval)
  }
  if (signature(yield* readPr(target)) !== signature(pr)) return yield* serviceError("stale_review", "The PR changed during publication; review its current range.")
  if (approval === "approve") {
    const url = yield* submitReview(target, review.head, "APPROVE", rendered).pipe(
      Effect.catchIf(error => error.code === "write_rejected", error => Effect.succeed({ action: "refused", code: error.code, message: error.message } satisfies ApprovalOutcome))
    )
    if (typeof url === "string") return result("created", url, { action: "approved", url })
    approval = url
  }
  return result("created", yield* submitReview(target, review.head, "COMMENT", rendered), approval)
})
