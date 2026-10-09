import { Effect, Schema } from "effect"
import picomatch from "picomatch"
import { AppGitHub } from "./app-github.js"
import { minimumConfidence, protectedPaths, ReviewRequest, serviceError, Sha } from "./app-protocol.js"
import type { ReviewResult, StampOutcome } from "./app-protocol.js"
import { commentMarker, maxCommentBytes, parsePullRequest, renderComment } from "./comment.js"
import { ConfigFile, configPath } from "./model.js"
import { parseJson } from "./policy.js"

const Identity = Schema.Struct({ login: Schema.String })
const Pr = Schema.Struct({ state: Schema.String, draft: Schema.Boolean, head: Schema.Struct({ sha: Sha }), base: Schema.Struct({ sha: Sha }), changed_files: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })
type Pr = typeof Pr.Type
const File = Schema.Struct({ filename: Schema.String, previous_filename: Schema.optional(Schema.String), additions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), deletions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), patch: Schema.optional(Schema.String) })
const Review = Schema.Struct({ state: Schema.String, commit_id: Schema.NullOr(Sha), html_url: Schema.String, user: Schema.NullOr(Identity) })
const Comment = Schema.Struct({ id: Schema.Int, html_url: Schema.String, body: Schema.NullOr(Schema.String), user: Schema.NullOr(Identity) })
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

/** Creates or updates the app's one marked review comment on the PR. */
const writeComment = Effect.fn("App.writeComment")(function*(target: Target, pr: Pr, body: string) {
  const gh = yield* AppGitHub
  const owned = (yield* pages(target.token, `repos/${target.repository}/issues/${target.number}/comments`, Comment))
    .filter(comment => comment.user?.login === target.login && comment.body?.startsWith(`${commentMarker}\n`))
  // Concurrent first publications can leave two app comments; later runs keep the oldest current.
  const existing = owned[0]
  if (existing?.body === body) return { action: "unchanged" as const, url: existing.html_url }
  if (signature(yield* readPr(target)) !== signature(pr)) return yield* serviceError("stale_review", "The PR changed during publication; review its current range.")
  const written = yield* Effect.uninterruptible(gh.request(
    target.token,
    existing === undefined ? "POST" : "PATCH",
    existing === undefined ? `repos/${target.repository}/issues/${target.number}/comments` : `repos/${target.repository}/issues/comments/${existing.id}`,
    { body }
  ).pipe(Effect.flatMap(raw => decode(Comment, raw))))
  if (written.user?.login !== target.login || !written.html_url.startsWith(`${target.url}#issuecomment-`)) {
    return yield* serviceError("write_uncertain", "GitHub returned an unexpected comment; inspect the PR.", 502)
  }
  return { action: existing === undefined ? "created" as const : "updated" as const, url: written.html_url }
})

const checkPolicy = Effect.fn("App.checkPolicy")(function*(target: Target, pr: Pr) {
  const gh = yield* AppGitHub
  const value = yield* gh.request(target.token, "GET", `repos/${target.repository}/contents/${configPath}?ref=${pr.base.sha}`).pipe(
    Effect.mapError((error) => error.code === "github_not_found" ? serviceError("stamp_disabled", `The base branch must have ${configPath} with stamp.enabled.`) : error)
  )
  const content = yield* decode(Schema.Struct({ type: Schema.Literal("file"), encoding: Schema.Literal("base64"), content: Schema.String, size: Schema.Int }), value)
  if (content.size > 100_000) return yield* serviceError("config_error", "The base config is too large.")
  const parsed = yield* parseJson(Buffer.from(content.content, "base64").toString("utf8"), configPath).pipe(Effect.mapError(() => serviceError("config_error", "The base review config is invalid.")))
  const config = yield* Schema.decodeUnknownEffect(ConfigFile, { onExcessProperty: "error" })(parsed).pipe(
    Effect.mapError(() => serviceError("config_error", "The base review config is invalid."))
  )
  const stamp = config.stamp
  if (!stamp?.enabled) return yield* serviceError("stamp_disabled", "The base branch does not enable stamping.")
  if (pr.changed_files > 3000) return yield* serviceError("coverage", "The PR has too many changed files.")
  const files = yield* pages(target.token, `repos/${target.repository}/pulls/${target.number}/files`, File, 31)
  if (files.length !== pr.changed_files) return yield* serviceError("coverage", "Changed-file coverage is incomplete.")
  let lines = 0
  for (const file of files) {
    if (file.patch === undefined) return yield* serviceError("coverage", "A changed file has no text patch; manual review is required.")
    for (const name of [file.filename, file.previous_filename].filter((name): name is string => name !== undefined)) {
      const protectedPath = [...protectedPaths, ...(stamp.denyPaths ?? [])].some(pattern => picomatch.isMatch(name, pattern, { dot: true, strictBrackets: true }))
      if (protectedPath) return yield* serviceError("protected_path", `A protected path changed: ${name}.`)
    }
    lines += file.additions + file.deletions
  }
  if (lines > (stamp.maxChangedLines ?? 400)) return yield* serviceError("size_limit", "The PR exceeds stamp.maxChangedLines.")
})

/** One GitHub App approves; GitHub's review list, not a database, makes repeated requests idempotent. */
const approve = Effect.fn("App.approve")(function*(target: Target, pr: Pr, prMergeBase: string, review: ReviewRequest, commentUrl: string) {
  if (review.findings.length > 0) return yield* serviceError("findings", "Accepted findings must be resolved before stamping.")
  if (review.confidence < minimumConfidence) return yield* serviceError("low_confidence", `Overall confidence ${review.confidence}/5 is below ${minimumConfidence}/5; request human review.`)
  if (pr.draft) return yield* serviceError("draft", "Stamping requires a non-draft PR.")
  if (review.base !== prMergeBase) return yield* serviceError("partial_review", "Stamping requires a review of the whole PR from its merge base.")
  yield* checkPolicy(target, pr)
  const gh = yield* AppGitHub
  const endpoint = `repos/${target.repository}/pulls/${target.number}`
  const ours = (yield* pages(target.token, `${endpoint}/reviews`, Review)).filter(item => item.user?.login === target.login && item.commit_id === review.head)
  const approved = ours.find(item => item.state === "APPROVED")
  if (approved) return { action: "already-approved", url: approved.html_url } satisfies StampOutcome
  if (ours.some(item => item.state === "DISMISSED")) return yield* serviceError("stamp_dismissed", "The Benedict approval for this commit was dismissed; a person must approve it.")
  if (signature(yield* readPr(target)) !== signature(pr)) return yield* serviceError("stale_review", "The PR changed before approval; review its current range.")
  const body = [
    "🤖 **Benedict — automated approval**",
    `Reviewed \`${review.base}\` → \`${review.head}\`.`,
    `Accepted findings: 0 · drafts dropped: ${review.dropped} · overall confidence: ${review.confidence}/5.`,
    `Review: ${commentUrl}`,
    "A developer's local AI review agent reviewed this PR; the Benedict GitHub App submitted this approval. Branch rules decide whether it satisfies merge requirements.",
    `<!-- benedict-stamp:${review.head} -->`
  ].join("\n\n")
  const written = yield* Effect.uninterruptible(gh.request(target.token, "POST", `${endpoint}/reviews`, { event: "APPROVE", commit_id: review.head, body }).pipe(Effect.flatMap(raw => decode(Review, raw))))
  if (written.state !== "APPROVED" || written.commit_id !== review.head || written.user?.login !== target.login || !written.html_url.startsWith(`${target.url}#pullrequestreview-`)) {
    return yield* serviceError("write_uncertain", "GitHub returned an unexpected approval; inspect the PR.", 502)
  }
  return { action: "approved", url: written.html_url } satisfies StampOutcome
})

/**
 * Posts a locally completed review as the Benedict GitHub App and, when requested, stamps it.
 * The service trusts the caller's review; it renders the comment itself and checks the PR range.
 */
export const publishAsApp = Effect.fn("App.publish")(function*(value: unknown) {
  const review = yield* Schema.decodeUnknownEffect(ReviewRequest, { onExcessProperty: "error" })(value).pipe(Effect.mapError(() => serviceError("invalid_request", "Invalid version-1 review request.", 400)))
  const pull = yield* Effect.try({ try: () => parsePullRequest(review.pr), catch: () => serviceError("invalid_request", "Use a full GitHub PR URL.", 400) })
  const body = renderComment(review, pull.repository)
  if (Buffer.byteLength(body, "utf8") > maxCommentBytes) return yield* serviceError("comment_too_large", `The review comment exceeds ${maxCommentBytes} bytes.`, 400)
  const gh = yield* AppGitHub
  const target: Target = { ...pull, ...(yield* gh.installation(pull.repository)) }
  const pr = yield* readPr(target)
  if (pr.state !== "open") return yield* serviceError("pr_closed", "The PR is closed.")
  if (pr.head.sha !== review.head) return yield* serviceError("stale_review", "The review is stale; review the current PR head.")
  const prMergeBase = yield* mergeBase(target, pr.base.sha, review.head)
  if (review.base !== prMergeBase && ((yield* mergeBase(target, prMergeBase, review.base)) !== prMergeBase || (yield* mergeBase(target, review.base, review.head)) !== review.base)) {
    return yield* serviceError("range_error", "The reviewed base must be the PR merge base or a later ancestor of its head.")
  }
  const comment = yield* writeComment(target, pr, body)
  // The comment is posted either way; a definite refusal is reported instead of failing the request.
  const stamp = review.stamp
    ? yield* approve(target, pr, prMergeBase, review, comment.url).pipe(
      Effect.catchIf(error => error.status < 500, error => Effect.succeed({ action: "refused", code: error.code, message: error.message } satisfies StampOutcome))
    )
    : null
  return { pr: target.url, head: review.head, postedBy: target.login, comment, stamp } satisfies ReviewResult
})
