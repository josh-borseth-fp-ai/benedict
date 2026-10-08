import { DateTime, Effect } from "effect"
import { RejectedFinding, ReviewReport } from "../domain/Model.js"
import { Git } from "../git/Git.js"
import { parseUnifiedDiff } from "../git/parseDiff.js"
import { buildChangeGraph, summarizeGraph } from "../intelligence/graph.js"
import { CodeRetriever } from "../intelligence/Retriever.js"
import { ReviewOptions } from "../options.js"
import { applyFloor, dedupeFindings, gateFindings } from "./filter.js"
import { isDecodeError, judgeFindings } from "./judge.js"
import { ReviewConfigStore } from "./config.js"
import { SkillRegistry } from "./skills.js"

const retrievalLimit = 12

export const review = Effect.fn("ReviewPipeline.review")(function*() {
  const options = yield* ReviewOptions
  const git = yield* Git
  const retriever = yield* CodeRetriever
  const configStore = yield* ReviewConfigStore
  const registry = yield* SkillRegistry

  const root = yield* git.repositoryRoot(options.repo)
  yield* Effect.logInfo(`Reviewing ${options.base}${options.worktree ? "" : `..${options.head}`} in ${root}`)
  const patch = yield* git.diff(root, options.base, options.head, options.worktree)
  const files = parseUnifiedDiff(patch)
  const parsed = yield* Effect.forEach(files, (file) =>
    file.binary || file.status === "deleted"
      ? Effect.succeed([])
      : retriever.changedSymbols(root, file.path, file.touchedLines), { concurrency: 4 })
  const symbols = parsed.flat().slice(0, 40)
  yield* Effect.logInfo(`Changed files ${files.length}, symbols ${symbols.length}`)

  const related = yield* Effect.forEach(symbols.slice(0, retrievalLimit), (item) =>
    retriever.getRelatedCode(root, item.symbol), { concurrency: 3 })
  const snippets = related.flat()
  const graph = summarizeGraph(buildChangeGraph({
    files: files.map((file) => file.path),
    symbols,
    snippets
  }))
  const config = yield* configStore.load(root)
  const notes = yield* configStore.projectNotes(root)
  const knownPaths = new Set([
    ...files.map((file) => file.path),
    ...snippets.map((snippet) => snippet.path)
  ])
  const context = {
    root,
    base: options.base,
    head: options.worktree ? "WORKTREE" : options.head,
    files,
    symbols: symbols.map((item) => item.symbol),
    snippets,
    graph,
    rules: config.rules,
    notes,
    config,
    knownPaths
  }

  const warnings: Array<string> = []
  const collected = []
  for (const skill of registry.skills) {
    if (!skill.shouldRun(context)) continue
    yield* Effect.logInfo(`Running ${skill.name}`)
    const outcome = yield* skill.review(context).pipe(Effect.result)
    if (outcome._tag === "Failure") {
      const error = outcome.failure
      if (isDecodeError(error)) {
        const message = `${skill.name} returned findings that could not be decoded`
        warnings.push(message)
        yield* Effect.logWarning(message)
        continue
      }
      return yield* error
    }
    collected.push(...outcome.success)
  }

  const deduped = dedupeFindings(collected)
  const gated = gateFindings({ findings: deduped, knownPaths })
  yield* Effect.logInfo(`Judging ${gated.kept.length} findings`)
  const judged = yield* judgeFindings(gated.kept, context).pipe(
    Effect.catch((error) => {
      if (!isDecodeError(error)) return Effect.fail(error)
      const message = "Judge output could not be decoded; no findings were accepted"
      warnings.push(message)
      return Effect.succeed({
        kept: [],
        rejected: gated.kept.map((finding) => new RejectedFinding({ finding, reason: message }))
      })
    })
  )
  const floored = applyFloor({
    findings: judged.kept,
    minimumSeverity: options.minSeverity,
    minimumConfidence: options.minConfidence
  })
  const now = yield* DateTime.now
  return new ReviewReport({
    generatedAt: DateTime.formatIso(now),
    repository: root,
    base: options.base,
    head: options.worktree ? "WORKTREE" : options.head,
    backend: options.backend,
    files: files.map((file) => file.path),
    symbols: context.symbols,
    rules: [...config.rules],
    findings: [...floored.kept],
    rejected: [...gated.rejected, ...judged.rejected, ...floored.rejected],
    warnings
  })
})
