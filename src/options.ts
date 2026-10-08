import { Context, Effect } from "effect"
import type { BackendName, OutputFormat, Severity } from "./domain/Model.js"

export class ReviewOptions extends Context.Service<ReviewOptions, {
  readonly repo: string
  readonly base: string
  readonly head: string
  readonly worktree: boolean
  readonly backend: BackendName
  readonly format: OutputFormat
  readonly minConfidence: number
  readonly minSeverity: Severity
  readonly timeoutSeconds: number
}>()("review-runtime/ReviewOptions") {}
