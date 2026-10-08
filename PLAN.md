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
