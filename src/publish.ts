import { Effect, FileSystem, Schema } from "effect"
import { publishAsApp } from "./app-publish.js"
import type { Decision } from "./app-publish.js"
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
  readonly contextFile?: string
  readonly confidence: number
  readonly decision: Decision
  readonly dryRun: boolean
}

const fail = (code: string, message: string) => new ReviewError({ code, message })

const decode = <S extends Schema.Top>(schema: S, value: unknown) => Schema.decodeUnknownEffect(schema)(value).pipe(
  Effect.mapError(() => fail("github_error", "GitHub returned an unexpected response."))
)

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
  const snapshot = yield* collectSnapshot({ repo: options.repo, base, head: options.head, worktree: false })
  const report = yield* checkFindings(snapshot, drafts)
  if (report.range.head !== pr.head.sha) {
    return yield* fail("stale_review", `Reviewed head ${report.range.head} differs from PR head ${pr.head.sha}. Review the current PR head before publishing.`)
  }
  const ancestor = (yield* git.run(snapshot.context.repository, ["merge-base", report.range.base, pr.head.sha])).trim()
  if (ancestor !== report.range.base) return yield* fail("range_error", "Reviewed base must be an ancestor of the PR head.")
  const prMergeBase = options.base === undefined ? base : yield* resolveMergeBase
  const sharedBase = (yield* git.run(snapshot.context.repository, ["merge-base", prMergeBase, report.range.base])).trim()
  if (sharedBase !== prMergeBase) return yield* fail("range_error", "Reviewed base is outside the PR range. Use the PR merge base or a later ancestor of its head.")
  // GitHub's PR patches decide which findings become inline comments.
  const patches = new Map<string, string>()
  for (let page = 1; page <= 30; page++) {
    const files = yield* decode(Schema.Array(PullRequestFile), yield* gh.request(`repos/${target.repository}/pulls/${target.number}/files?per_page=100&page=${page}`))
    for (const file of files) if (file.patch !== undefined) patches.set(file.filename, file.patch)
    if (files.length < 100) break
  }
  const review = {
    base: report.range.base, head: pr.head.sha,
    organizationRevision: report.organization?.revision ?? null,
    findings: report.accepted, dropped: report.summary.rejected,
    confidence: options.confidence, context
  }
  const rendered = renderReview(review, target.repository, patches)
  const tooLarge = oversized(rendered)
  if (tooLarge !== undefined) return yield* fail("comment_too_large", `${tooLarge} Shorten findings or context before publishing.`)
  const result = { formatVersion: 1 as const, pr: target.url, range: report.range, organization: report.organization, summary: report.summary, confidence: options.confidence, decision: options.decision, body: rendered.body, comments: rendered.comments }
  if (options.dryRun) return { ...result, action: "dry-run" as const, reviewUrl: null, postedBy: null, approval: null }
  const posted = yield* publishAsApp({ ...review, ...target, rendered, decision: options.decision })
  return { ...result, action: posted.review.action, reviewUrl: posted.review.url, postedBy: posted.postedBy, approval: posted.approval }
})
