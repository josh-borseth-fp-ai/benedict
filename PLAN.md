# Plan

Build a portable review skill backed by a deterministic Effect TypeScript CLI. Any coding agent can follow the skill and run the commands.

## Responsibilities

The skill guides investigation: read the change, trace related code, apply correctness and security, and establish whether a suspected defect is real.

`review context` resolves a Git range and returns changed files, patches, line counts, changed lines, applicable lenses, and repository rules. Commit reviews use source from Git; worktree reviews include staged, unstaged, and untracked files.

`review check` validates finding structure, diff membership, file type, source line ranges, quoted evidence, permitted lenses, severity and confidence thresholds, and duplicate findings. It returns accepted findings and rejected drafts with reasons.

`review publish` reuses that validator, renders a fixed AI attribution, verifies the PR range, and creates or updates an owned automation comment through GitHub CLI. The skill selects useful findings and context; deterministic code owns formatting, destination checks, and API operations.

## Pipeline

```
Coding agent loads the skill
  → review context
  → investigate changed and related code
  → write draft findings
  → review check
  → report accepted findings and dropped draft count
  → review publish for GitHub PR reviews, unless local-only
```

## Boundaries

The existing coding agent owns investigation and judgment. The CLI reads the repository, runs Git, checks mechanical constraints, and publishes PR conversation comments through `gh`. GitHub authentication stays with `gh`. The CLI does not launch another agent, handle provider credentials, or modify reviewed files. Passing validation does not prove that a finding describes a real bug.

## First slice

- Local installation and commands for context and finding validation.
- JSON output for coding agents and text output for people.
- Repository configuration for correctness and security, path rules, and thresholds.
- Integration tests against temporary Git repositories.
- Skill instructions and a finding format reference.

## Later

Add targeted retrieval or additional conditional review lenses when real reviews demonstrate a need. Keep hosted services, provider orchestration, autonomous edits, and a vector database outside the project scope.

## Stamp

The stamp bot in Teams approves a PR when someone posts `stamp <url>` in its channel. The review agent can post that for a clean PR.

- `scripts/stamp.ts` decides, not the model. It checks the PR is open and current, the review covered the whole PR, there are no findings, no protected path changed, and the PR is under the line limit. It reads those rules from the base branch.
- Posting goes out as the developer. Teams uses [`@floriscornel/teams-mcp`](https://github.com/floriscornel/teams-mcp), which runs locally and signs in with the developer's Microsoft account. GitHub uses `gh`. There is no separate bot or service account.
- The Teams message and a PR comment carry the 🤖 Review Agent attribution. A hidden marker in the comment stops a second stamp for the same head commit.
- `yaml` reads `review.yaml`; `picomatch` uses the same deny-path glob semantics as the review CLI.
