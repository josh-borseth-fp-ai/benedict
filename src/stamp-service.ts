import { Effect, Schema } from "effect"
import picomatch from "picomatch"
import { ConfigFile, configPath } from "./model.js"
import { parseJson } from "./policy.js"
import { parsePullRequest } from "./publish.js"
import { StampGitHub } from "./stamp-github.js"
import { minimumConfidence, protectedPaths, publishedConfidence, Sha, StampReport, stampError } from "./stamp-protocol.js"
import type { StampResult } from "./stamp-protocol.js"

const Identity = Schema.Struct({ id: Schema.Int, login: Schema.String })
const Pr = Schema.Struct({ state: Schema.String, draft: Schema.Boolean, head: Schema.Struct({ sha: Sha }), base: Schema.Struct({ sha: Sha }), user: Identity, changed_files: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })
type Pr = typeof Pr.Type
const File = Schema.Struct({ filename: Schema.String, previous_filename: Schema.optional(Schema.String), additions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), deletions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), patch: Schema.optional(Schema.String) })
const Review = Schema.Struct({ state: Schema.String, commit_id: Schema.NullOr(Sha), html_url: Schema.String, user: Schema.NullOr(Identity) })
const Comment = Schema.Struct({ body: Schema.NullOr(Schema.String), issue_url: Schema.String })

const decode = <S extends Schema.Top>(schema: S, value: unknown) => Schema.decodeUnknownEffect(schema)(value).pipe(
  Effect.mapError(() => stampError("invalid_response", "The stamp service received an invalid response.", 502))
)
const signature = (pr: Pr) => [pr.state, pr.draft, pr.head.sha, pr.base.sha].join(":")

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

/** The published review must be this PR's comment for the same range, with no findings and the requested confidence. */
const checkReviewComment = Effect.fn("Stamp.checkReviewComment")(function*(token: string, repository: string, report: StampReport) {
  const target = parsePullRequest(report.pr)
  const match = /^(.+)#issuecomment-([1-9]\d*)$/.exec(report.reviewComment)
  if (!match || match[1] !== target.url) return yield* stampError("invalid_report", "reviewComment must be a comment URL on the stamped PR.", 400)
  const gh = yield* StampGitHub
  const comment = yield* gh.request(token, "GET", `repos/${repository}/issues/comments/${match[2]}`).pipe(
    Effect.catchIf(error => error.code === "github_not_found", () => Effect.fail(stampError("review_missing", "The published review comment was not found."))),
    Effect.flatMap(value => decode(Comment, value))
  )
  if (comment.issue_url.toLowerCase() !== `https://api.github.com/repos/${repository}/issues/${target.number}`.toLowerCase()) {
    return yield* stampError("review_missing", "The review comment belongs to a different PR.")
  }
  if (publishedConfidence(comment.body ?? "", report.base, report.head) !== report.confidence) {
    return yield* stampError("review_mismatch", "The published review does not record this range, zero accepted findings and the requested confidence.")
  }
})

/** One GitHub App approves; GitHub's review list, not a database, makes repeated requests idempotent. */
export const approveStamp = Effect.fn("Stamp.approve")(function*(value: unknown, service: string) {
  const report = yield* Schema.decodeUnknownEffect(StampReport, { onExcessProperty: "error" })(value).pipe(Effect.mapError(() => stampError("invalid_report", "Invalid version-2 stamp report.", 400)))
  const target = yield* Effect.try({ try: () => parsePullRequest(report.pr), catch: () => stampError("invalid_report", "Use a full GitHub PR URL.", 400) })
  if (report.findings.length > 0) return yield* stampError("findings", "Accepted findings must be resolved before stamping.")
  if (report.confidence < minimumConfidence) return yield* stampError("low_confidence", `Overall confidence ${report.confidence}/5 is below ${minimumConfidence}/5; request human review.`)
  const gh = yield* StampGitHub
  const { token, login } = yield* gh.installation(target.repository)
  const endpoint = `repos/${target.repository}/pulls/${target.number}`
  const pr = yield* decode(Pr, yield* gh.request(token, "GET", endpoint))
  yield* checkPolicy(token, target.repository, pr, report, service)
  yield* checkReviewComment(token, target.repository, report)
  const ours = (yield* pages(token, `${endpoint}/reviews`, Review)).filter(review => review.user?.login === login && review.commit_id === report.head)
  const approved = ours.find(review => review.state === "APPROVED")
  if (approved) return { action: "already-approved", pr: target.url, head: report.head, approvedBy: login, reviewUrl: approved.html_url } satisfies StampResult
  if (ours.some(review => review.state === "DISMISSED")) return yield* stampError("stamp_dismissed", "The Review Agent approval for this commit was dismissed; a person must approve it.")
  const current = yield* decode(Pr, yield* gh.request(token, "GET", endpoint))
  if (signature(current) !== signature(pr)) return yield* stampError("stale_review", "The PR changed before approval; review its current range.")
  const body = [
    "🤖 **Review Agent — automated approval**",
    `Reviewed \`${report.base}\` → \`${report.head}\`.`,
    `Accepted findings: 0 · drafts dropped: ${report.dropped} · overall confidence: ${report.confidence}/5.`,
    `Review: ${report.reviewComment}`,
    "A developer's local AI review agent reviewed this PR; the Review Agent GitHub App submitted this approval. Branch rules decide whether it satisfies merge requirements.",
    `<!-- review-agent-stamp:${report.head} -->`
  ].join("\n\n")
  // Finish the write even if the HTTP caller disconnects.
  const review = yield* Effect.uninterruptible(gh.request(token, "POST", `${endpoint}/reviews`, { event: "APPROVE", commit_id: report.head, body }).pipe(Effect.flatMap(raw => decode(Review, raw))))
  if (review.state !== "APPROVED" || review.commit_id !== report.head || review.user?.login !== login || !review.html_url.startsWith(`${target.url}#pullrequestreview-`)) {
    return yield* stampError("write_uncertain", "GitHub returned an unexpected approval; inspect the PR.", 502)
  }
  return { action: "approved", pr: target.url, head: report.head, approvedBy: login, reviewUrl: review.html_url } satisfies StampResult
})
