# Personal review runtime

A local code-review runtime for one machine. It tells an existing coding agent what changed, which code is related, which skills apply, and which findings are worth keeping.

The model is replaceable. The runtime launches the official Codex CLI or Claude Code CLI and lets that CLI own authentication. It does not read provider credentials, session cookies, or subscription tokens.

## What v0 does

```
review HEAD~1
```

1. Reads `git diff` from the base ref to `HEAD` (default base: `HEAD~1`).
2. Finds changed files and, for TypeScript and JavaScript, the symbols that overlap the diff.
3. Retrieves callers, references, callees, and tests with ripgrep and Tree-sitter.
4. Runs the correctness and security skills.
5. Asks Codex or Claude Code to investigate, in a read-only sandbox.
6. Runs a judge pass and drops findings that lack evidence or confidence.
7. Prints a short summary and structured JSON.

## Run

```bash
pnpm install
pnpm review -- --help
pnpm review -- HEAD~1 --backend codex
pnpm review -- HEAD~1 --backend claude --format json
```

`--worktree` diffs the working tree against the base ref. `--format json` prints only the report.

The official CLI must already be installed and authenticated (`codex` or `claude`). This process never opens `~/.codex` or `~/.claude` credential files. A missing CLI fails the command.

## Repository config

Optional `review.yaml`, `review.yml`, or `review.json` in the repository root:

```yaml
skills:
  - correctness
  - security
severity:
  minimum: medium
paths:
  - pattern: "api/**"
    skills:
      - security
rules:
  - Do not report style-only issues.
  - Only report findings that can cause a real defect or meaningful risk.
  - Prefer evidence from the repository over assumptions.
minimumConfidence: 0.7
```

`AGENTS.md`, `CLAUDE.md`, and `CODEOWNERS` are included as notes when they exist. Path rules limit which skills run. Database, API-compatibility, and other skills are later.

Flags override the file: `--min-severity`, `--min-confidence`, `--backend`.

## Layout

Effect services, layers, and schemas are the implementation. The agent backend is a `Context.Service` with two layers, `codexLayer` and `claudeLayer`. Both shell out through `effect/process`. Git, ripgrep, the filesystem, config, and YAML go through Effect platform modules. Changed-symbol relationships are an Effect `Graph`. Response shapes are Effect `Schema`, and the same schema is handed to the CLI as JSON Schema.

## Tests

```bash
pnpm test
```

The tests use a stand-in agent so they do not call Codex or Claude.
