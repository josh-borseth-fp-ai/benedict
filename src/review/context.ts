import type { CodeSymbol, FileDiff, Finding, Snippet } from "../domain/Model.js"
import type { ResolvedReviewConfig } from "../domain/Model.js"

export interface ReviewContext {
  readonly root: string
  readonly base: string
  readonly head: string
  readonly files: ReadonlyArray<FileDiff>
  readonly symbols: ReadonlyArray<CodeSymbol>
  readonly snippets: ReadonlyArray<Snippet>
  readonly graph: string
  readonly rules: ReadonlyArray<string>
  readonly notes: ReadonlyArray<{ readonly path: string; readonly text: string }>
  readonly config: ResolvedReviewConfig
  readonly knownPaths: ReadonlySet<string>
}

export interface CandidateSet {
  readonly findings: ReadonlyArray<Finding>
  readonly warnings: ReadonlyArray<string>
}
