# Plan

Build a portable review skill backed by a deterministic Effect TypeScript CLI. Any coding agent can follow the skill and run the commands.

## Responsibilities

The skill guides investigation: read the change, trace related code, apply correctness and security, and establish whether a suspected defect is real. It also assesses merge confidence on a five-point scale and diagrams the affected architecture for each PR. Individual finding confidence remains on the 0–1 scale.

`review context` resolves a Git range and returns changed files, patches, line counts, changed lines, applicable lenses, and repository rules. Commit reviews use source from Git; worktree reviews include staged, unstaged, and untracked files.

`review check` validates finding structure, diff membership, file type, source line ranges, quoted evidence, permitted lenses, severity and confidence thresholds, and duplicate findings. It returns accepted findings and rejected drafts with reasons.

`review setup` installs the bundled skill through Vercel's skills CLI, optionally connects a repository to organization knowledge, and records its initial revision. `review sync` restores that locked revision into a local cache; `--update` explicitly adopts a newer version.

Repository policy and Markdown knowledge live alongside the code. Organization defaults, required constraints, and shared documents live in an organization-owned Git repository. `.review/knowledge.lock.json` records the selected source and commit. Review commands use that exact cache offline and include its revision in their output.

`review publish` reuses that validator, renders a fixed AI attribution, verifies the PR range, and creates or updates an owned automation comment through GitHub CLI. The skill selects useful findings and context; deterministic code owns formatting, destination checks, and API operations.

## Pipeline

```
Coding agent loads the skill
  → review context
  → investigate changed and related code
  → write draft findings
  → review check
  → report accepted findings, dropped draft count, and overall confidence out of five
  → for a PR, diagram its changed architecture and write score, rationale, and Mermaid to Markdown context
  → review publish for GitHub PR reviews, unless local-only
```

## Boundaries

The existing coding agent owns investigation and judgment. Review commands read the repository, run Git, and check mechanical constraints. Setup and sync explicitly write installation/configuration/lock state; they never change application source or execute organization code. PR publishing uses GitHub CLI, which owns its authentication. The CLI does not launch another agent or handle provider credentials. Passing validation does not prove that a finding describes a real bug.

## First slice

- Local installation and commands for context and finding validation.
- JSON output for coding agents and text output for people.
- Repository configuration for correctness and security, path rules, and thresholds.
- Integration tests against temporary Git repositories.
- Skill instructions and a finding format reference.
- Guided user/project skill installation from the bundled release.
- Approved, versioned repo and organization knowledge with explicit cache synchronization.
- Organization defaults and mandatory lenses, thresholds, and retained rules.

## Later

Add targeted retrieval or additional conditional review lenses when real reviews demonstrate a need. Keep hosted services, provider orchestration, autonomous edits, and a vector database outside the project scope.

## Stamp

The stamp bot in Teams approves a PR when someone posts `stamp <url>` in its channel. The review agent can post that for a clean PR.

- `scripts/stamp.ts` decides, not the model. It checks the PR is open and current, the review covered the whole PR, there are no findings, no protected path changed, and the PR is under the line limit. It reads those rules from the base branch.
- Posting goes out as the developer. Teams uses [`@floriscornel/teams-mcp`](https://github.com/floriscornel/teams-mcp), which runs locally and signs in with the developer's Microsoft account. GitHub uses `gh`. There is no separate bot or service account.
- The Teams message and a PR comment carry the 🤖 Review Agent attribution. A hidden marker in the comment stops a second stamp for the same head commit.
- `yaml` reads `review.yaml`; `picomatch` uses the same deny-path glob semantics as the review CLI.
