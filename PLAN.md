# Plan

The useful product is a local review runtime that tells an existing coding agent what changed, what matters, and what is worth reporting. The model and the CLI are replaceable.

## What it is

A personal, local-first code-review runtime. It runs on your machine against a git repo and launches the official Codex CLI or Claude Code CLI. Those CLIs own authentication. This project owns review workflow: diffs, related code, skills, evidence, and a judge.

T3 Code stays the agent control plane. This project is the review intelligence it can invoke. Do not rebuild T3's session machinery, and do not build another "AI reviews my PR" wrapper.

## Trust boundary

The user authenticates the official CLI locally. The runtime launches that CLI and never sees provider credentials.

Do not scrape session cookies, extract or proxy subscription tokens, impersonate provider APIs, or turn a personal subscription into a hosted service. Re-check OpenAI and Anthropic terms before distributing or commercializing anything.

## Pipeline

```
diff
  → changed files and symbols
  → related callers, references, tests
  → applicable skills only
  → evidence
  → critic / judge
  → high-confidence findings
```

A finding is structured: file, range, severity, category, title, explanation, evidence, suggested fix, confidence, and the skill that produced it. The judge drops findings that lack repository evidence.

## Skills

Skills are small and conditional. Run database checks only when migrations change, API-compatibility checks only when public API or schema files change, concurrency checks only when shared state changes.

v0 skills: correctness and security. Later: API compatibility, then concurrency, performance, database, testing, and framework-specific rules.

Each skill declares when it applies, what context it needs, which tools it may use, and what confidence it requires. Repository config (`review.skills`, path rules, severity floor) and existing docs (`AGENTS.md`, `CLAUDE.md`, `CODEOWNERS`) can narrow that further.

Global rules for v0:

- Skip style-only issues.
- Report only real defects or meaningful risk.
- Prefer repository evidence over assumptions.

## Tools

Deterministic and inspectable:

`get_diff`, `read_file`, `search`, `find_symbol`, `find_references`, `find_callers`, `find_callees`, `get_related_code`, `get_tests_for`, `run_test`, `run_static_analysis`.

Repository intelligence starts with `git diff`, `git show`, ripgrep, and Tree-sitter. A symbol index, SCIP, and embeddings come later. The graph is for retrieval, not for dumping into a prompt.

## v0

One command, one local repo: `review HEAD~1`. Default base is the previous commit.

1. Compact diff and changed files.
2. Changed symbols via Tree-sitter where practical.
3. Directly related code: callers, references, tests.
4. Correctness and security skills.
5. One official CLI investigates.
6. A second pass validates findings.
7. Print JSON plus a short human summary of high-confidence findings only.

The backend interface must stay swappable, and the runtime must never read provider credentials.

## Later, in order

1. Persistent symbol index, SCIP, richer retrieval, repo review config beyond the v0 file.
2. More skills, dedup improvements, and running tests or static analysis.
3. T3 invokes the runtime and receives structured findings.
4. GitHub PR inspection, optional review comments, optional personal Actions.

## Out of scope

Hosted SaaS, multi-user auth, billing, credential proxying, autonomous edits, a vector database, every language, and every coding agent.
