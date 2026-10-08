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

Add targeted retrieval or additional conditional review lenses when real reviews demonstrate a need. Keep provider orchestration, autonomous edits, and a vector database outside the project scope. The stamp service below is the shared approval component.

## Stamp

`review stamp approve` validates the original findings against the resolved whole-PR range, checks the current head, and reads stamp authorization and the service endpoint from the base commit. It calls the shared service with the reviewed base/head and zero accepted findings.

`src/stamp*.ts` adapts the GitHub reviewer pool from ForwardPathAI/fp-git-helper into an Effect HTTP service with Azure Table storage. `review stamp serve` runs the service. Reviewers explicitly enroll through `review stamp enroll` and GitHub device authorization; administration uses `users` and `remove`. There is no project frontend or Python runtime. The service excludes the author, verifies current metadata and base-branch policy through GitHub, reserves the PR/head pair, and submits an AI-attributed approval at that commit. Only explicit GitHub refusals permit another candidate; uncertain writes stop for inspection. `stamp-service/` contains deployment documentation and source attribution.

The organization deploys the service and configures its repository allowlist. Developers configure a stamp endpoint key; Teams and local MCPs are not required. The existing review agent still owns investigation; the service does not launch another model.
