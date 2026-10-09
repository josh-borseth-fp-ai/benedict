import { Effect, Schema } from "effect"
import { Git } from "./git.js"
import { GitHub } from "./github.js"
import { ReviewError } from "./model.js"
import { parsePullRequest } from "./publish.js"

const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
const PullRequest = Schema.Struct({
  head: Schema.Struct({ sha: Sha }),
  base: Schema.Struct({ sha: Sha, ref: Schema.String.check(Schema.isPattern(/^[^\s:]+$/)) })
})

const fail = (code: string, message: string) => new ReviewError({ code, message })

/** Extracts OWNER/REPO from https, ssh:// and scp-style github.com remote URLs. */
export const githubRepository = (url: string): string | null => {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return match ? match[1]!.toLowerCase() : null
}

export interface ResolvedPullRequest {
  readonly url: string
  readonly base: string
  readonly head: string
}

/**
 * Resolves a PR to its merge base and head with gh, fetching missing commits from the
 * matching github.com remote. The diff itself is always read from local Git.
 */
export const resolvePullRequest = Effect.fn("Review.resolvePullRequest")(function*(repo: string, url: string, base?: string) {
  const target = yield* Effect.try({ try: () => parsePullRequest(url), catch: (error) => fail("input_error", String(error)) })
  const gh = yield* GitHub
  const git = yield* Git
  const pr = yield* gh.request("GET", `repos/${target.repository}/pulls/${target.number}`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PullRequest)),
    Effect.mapError((error) => error instanceof ReviewError ? error : fail("github_error", "GitHub returned unexpected PR metadata."))
  )
  const root = (yield* git.run(repo, ["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, "")
  const hasCommit = (sha: string) => git.run(root, ["cat-file", "-e", `${sha}^{commit}`]).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  )
  const present = () => Effect.all([hasCommit(pr.base.sha), hasCommit(pr.head.sha)]).pipe(Effect.map((found) => found.every(Boolean)))

  if (!(yield* present())) {
    const config = yield* git.run(root, ["config", "--get-regexp", "^remote\\..*\\.url$"]).pipe(Effect.orElseSucceed(() => ""))
    const remote = config.split("\n").map((line) => /^remote\.(.+)\.url (.+)$/.exec(line))
      .find((match) => match !== null && githubRepository(match[2]!) === target.repository.toLowerCase())?.[1]
    if (remote === undefined) {
      return yield* fail("range_error", `The PR commits are not available locally and no remote points to github.com/${target.repository}. Add that remote or fetch the PR head and base, then retry.`)
    }
    // Refspecs without destinations download objects without moving local branches.
    yield* git.run(root, [
      "-c", "protocol.ext.allow=never", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--", remote,
      `refs/pull/${target.number}/head`, `refs/heads/${pr.base.ref}`
    ], { timeout: "5 minutes" }).pipe(
      Effect.mapError((error) => fail("git_error", `Cannot fetch the PR from remote ${JSON.stringify(remote)}: ${error.message}`))
    )
    if (!(yield* present())) return yield* fail("stale_review", "The PR changed while its commits were fetched. Run the command again.")
  }

  const mergeBase = (yield* git.run(root, ["merge-base", pr.base.sha, pr.head.sha])).trim()
  if (base === undefined) return { url: target.url, base: mergeBase, head: pr.head.sha } satisfies ResolvedPullRequest
  const resolved = yield* git.run(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).pipe(
    Effect.map((value) => value.trim()),
    Effect.mapError(() => fail("range_error", `Cannot resolve commit ${JSON.stringify(base)}.`))
  )
  const isAncestor = (ancestor: string, descendant: string) => git.run(root, ["merge-base", "--is-ancestor", ancestor, descendant]).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false)
  )
  // A narrower range must start inside the PR: after its merge base and at or before its head.
  if (!(yield* isAncestor(mergeBase, resolved)) || !(yield* isAncestor(resolved, pr.head.sha))) {
    return yield* fail("range_error", "Reviewed base is outside the PR range. Use the PR merge base or a later ancestor of its head.")
  }
  return { url: target.url, base: resolved, head: pr.head.sha } satisfies ResolvedPullRequest
})
