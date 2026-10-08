import type { BackendName } from "../domain/Model.js"

export interface CliLaunch {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly stdin: string
}

/**
 * `codex exec` owns ChatGPT authentication. The prompt is stdin, not an argument.
 * `--sandbox read-only` keeps the review from editing the repository.
 * Paths and the schema file are data. Flags are the fixed list below.
 */
export const codexLaunch = (input: {
  readonly repo: string
  readonly schemaPath: string
  readonly outputPath: string
  readonly prompt: string
}): CliLaunch => ({
  command: "codex",
  args: [
    "exec",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "-C",
    input.repo,
    "--output-schema",
    input.schemaPath,
    "--output-last-message",
    input.outputPath,
    "-"
  ],
  stdin: input.prompt
})

/**
 * `claude -p` owns Claude authentication. Plan mode plus denied prompts keeps
 * the session from waiting on an approval or writing the tree.
 */
export const claudeLaunch = (input: {
  readonly schemaJson: string
  readonly prompt: string
}): CliLaunch => ({
  command: "claude",
  args: [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    input.schemaJson,
    "--permission-mode",
    "plan",
    "--permission-prompts",
    "none"
  ],
  stdin: input.prompt
})

export const commandFor = (backend: BackendName): string =>
  backend === "codex" ? "codex" : "claude"
