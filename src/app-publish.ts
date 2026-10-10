import { Effect, Schema } from "effect"
import { AppGitHub, uncertainCodes } from "./app-github.js"
import { reviewMarker } from "./comment.js"
import type { PublishedReview, RenderedReview } from "./comment.js"
import { ReviewError } from "./model.js"

/** The reviewer's own call on whether the PR is safe to approve. */
export type Decision = "approve" | "comment"

/** A review the CLI has validated and rendered, ready to post as the GitHub App. */
export interface AppReview extends PublishedReview {
  readonly repository: string
  readonly number: number
  readonly url: string
  readonly rendered: RenderedReview
  readonly decision: Decision
}

export type ApprovalOutcome =
  | { readonly action: "approved" | "already-approved"; readonly url: string }
  | { readonly action: "refused"; readonly code: string; readonly message: string }

export interface AppResult {
  readonly postedBy: string
  readonly review: { readonly action: "created" | "unchanged"; readonly url: string }
  readonly approval: ApprovalOutcome | null
}

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
const Identity = Schema.Struct({ login: Schema.String })
const Pr = Schema.Struct({ state: Schema.String, head: Schema.Struct({ sha: Sha }), base: Schema.Struct({ sha: Sha }) })
type Pr = typeof Pr.Type
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

const fail = (code: string, message: string) => new ReviewError({ code, message })
const decode = <S extends Schema.Top>(schema: S, value: unknown) => Schema.decodeUnknownEffect(schema)(value).pipe(
  Effect.mapError(() => fail("invalid_response", "GitHub returned an unexpected response."))
)
const signature = (pr: Pr) => [pr.state, pr.head.sha, pr.base.sha].join(":")

const pages = Effect.fn("App.pages")(function*<S extends Schema.Top>(token: string, endpoint: string, schema: S) {
  const gh = yield* AppGitHub
  const items: Array<S["Type"]> = []
  for (let page = 1; page <= 100; page++) {
    const batch = yield* decode(Schema.Array(schema), yield* gh.request(token, "GET", `${endpoint}?per_page=100&page=${page}`))
    items.push(...batch)
    if (batch.length < 100) return items
  }
  return yield* fail("coverage", "Cannot inspect all GitHub pages; manual review is required.")
})

const mergeBase = Effect.fn("App.mergeBase")(function*(target: Target, base: string, head: string) {
  const gh = yield* AppGitHub
  return (yield* decode(Comparison, yield* gh.request(target.token, "GET", `repos/${target.repository}/compare/${base}...${head}`))).merge_base_commit.sha
})

const readPr = Effect.fn("App.readPr")(function*(target: Target) {
  const gh = yield* AppGitHub
  return yield* decode(Pr, yield* gh.request(target.token, "GET", `repos/${target.repository}/pulls/${target.number}`))
})

/**
 * The reviewer decides whether to approve. These checks only make sure the approval covers what was reviewed.
 * GitHub's review list, not a database, makes repeated requests idempotent.
 */
const approvalDecision = Effect.fn("App.approvalDecision")(function*(target: Target, pr: Pr, review: AppReview, ours: ReadonlyArray<Review>) {
  if (review.base !== (yield* mergeBase(target, pr.base.sha, review.head))) return yield* fail("partial_review", "Approval requires a review of the whole PR from its merge base.")
  const approved = ours.find(item => item.state === "APPROVED")
  if (approved) return { action: "already-approved", url: approved.html_url } satisfies ApprovalOutcome
  if (ours.some(item => item.state === "DISMISSED")) return yield* fail("approval_dismissed", "The Benedict approval for this commit was dismissed; a person must approve it.")
  return "approve" as const
})

/** Submits one GitHub review at the reviewed head: the summary body and one inline comment per anchored finding. */
const submitReview = Effect.fn("App.submitReview")(function*(target: Target, head: string, event: "APPROVE" | "COMMENT", rendered: RenderedReview) {
  const gh = yield* AppGitHub
  const body = event === "APPROVE"
    ? `${rendered.body}\n🤖 **Benedict — automated approval.** The AI reviewer judged commit \`${head}\` safe to approve, and the Benedict GitHub App approved it. Branch rules decide whether it satisfies merge requirements.\n`
    : rendered.body
  const comments = rendered.comments.map(comment => ({
    path: comment.path, body: comment.body, side: "RIGHT", line: comment.line,
    ...(comment.startLine === comment.line ? {} : { start_line: comment.startLine, start_side: "RIGHT" })
  }))
  const written = yield* Effect.uninterruptible(gh.request(target.token, "POST", `repos/${target.repository}/pulls/${target.number}/reviews`, { event, commit_id: head, body, comments }).pipe(
    Effect.flatMap(raw => decode(Review, raw))
  ))
  if (written.state !== (event === "APPROVE" ? "APPROVED" : "COMMENTED") || written.commit_id !== head || written.user?.login !== target.login || !written.html_url.startsWith(`${target.url}#pullrequestreview-`)) {
    return yield* fail("write_uncertain", "GitHub returned an unexpected review; inspect the PR.")
  }
  return written.html_url
})

/**
 * Posts a locally validated review as a new Benedict GitHub App review and, when the reviewer decided to approve, approves with it.
 * PR metadata is reread with the app token so the write targets the reviewed head.
 */
export const publishAsApp = Effect.fn("App.publish")(function*(review: AppReview) {
  const gh = yield* AppGitHub
  const target: Target = { repository: review.repository, number: review.number, url: review.url, ...(yield* gh.installation(review.repository)) }
  const pr = yield* readPr(target)
  if (pr.state !== "open") return yield* fail("pr_closed", "The PR is closed.")
  if (pr.head.sha !== review.head) return yield* fail("stale_review", "The review is stale; review the current PR head.")
  const ours = (yield* pages(target.token, `repos/${target.repository}/pulls/${target.number}/reviews`, Review))
    .filter(item => item.user?.login === target.login && item.commit_id === review.head)
  // A definite refusal is reported next to the posted review instead of failing the command.
  let approval: ApprovalOutcome | "approve" | null = review.decision === "approve"
    ? yield* approvalDecision(target, pr, review, ours).pipe(
      Effect.catchIf(error => !uncertainCodes.has(error.code), error => Effect.succeed({ action: "refused", code: error.code, message: error.message } satisfies ApprovalOutcome))
    )
    : null
  const result = (action: "created" | "unchanged", url: string, outcome: ApprovalOutcome | null) =>
    ({ postedBy: target.login, review: { action, url }, approval: outcome }) satisfies AppResult
  if (approval !== "approve") {
    // Rerunning the same review, for example after a timeout, finds the review that landed.
    const existing = ours.find(item => item.body?.startsWith(`${reviewMarker(review)}\n`))
    if (existing) return result("unchanged", existing.html_url, approval)
  }
  if (signature(yield* readPr(target)) !== signature(pr)) return yield* fail("stale_review", "The PR changed during publication; review its current range.")
  if (approval === "approve") {
    const url = yield* submitReview(target, review.head, "APPROVE", review.rendered).pipe(
      Effect.catchIf(error => error.code === "write_rejected", error => Effect.succeed({ action: "refused", code: error.code, message: error.message } satisfies ApprovalOutcome))
    )
    if (typeof url === "string") return result("created", url, { action: "approved", url })
    approval = url
  }
  return result("created", yield* submitReview(target, review.head, "COMMENT", review.rendered), approval)
})
