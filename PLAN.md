# Plan

Build a portable review skill backed by a deterministic Effect TypeScript CLI. Any coding agent can follow the skill and run the commands.

## Responsibilities

The skill guides investigation: read the change, trace related code, apply correctness and security, and establish whether a suspected defect is real. It also assesses merge confidence on a five-point scale and diagrams the affected architecture for each PR. Individual finding confidence remains on the 0–1 scale.

`review context` resolves a Git range and returns changed files, patches, line counts, changed lines, applicable lenses, and repository rules. Commit reviews use source from Git; worktree reviews include staged, unstaged, and untracked files.

`review check` validates finding structure, diff membership, file type, source line ranges, quoted evidence, permitted lenses, severity and confidence thresholds, and duplicate findings. It returns accepted findings and rejected drafts with reasons.

`review setup` installs the bundled skill through Vercel's skills CLI, optionally connects a repository to organization knowledge, and records its initial revision. `review sync` restores that locked revision into a local cache; `--update` explicitly adopts a newer version.

Repository policy (`.review/config.json`) and Markdown knowledge live alongside the code. Organization defaults, required constraints, and shared documents live in an organization-owned Git repository's `.review/organization.json`, using the same policy field names. `.review/knowledge.lock.json` records the selected source and commit. Review commands use that exact cache offline and include its revision in their output.

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

The developer's local coding agent reviews every PR, and a small approval service submits the approval as a single GitHub App. The opted-in reviewer pool, round-robin selection, user tokens and Azure Table storage are removed.

### Flow

```
Local agent follows the repository's AGENTS.md
  → review context, investigate, review check, review publish (unchanged)
  → review stamp approve --confidence N
      local gates: zero accepted findings, confidence ≥ 4, whole current PR,
      base-branch stamp config, protected paths, size limit
  → POST REVIEW_STAMP_URL with x-review-key
  → approval service
      authenticates the key, mints an installation token for the one repository,
      repeats the gates against GitHub, checks for an existing bot approval
  → POST /pulls/N/reviews as review-agent[bot]: APPROVE at the reviewed head
```

The service trusts the caller's review. It does not run a model; the local agent owns investigation and judgment. An approval means a key holder's agent reviewed the whole current PR and reported no blocking defects, under rules fixed by the base branch.

### Approval criteria

Both are required:

- **Zero accepted findings.** `review check` removes drafts outside the diff, without matching evidence, below `severity.minimum` (default medium), below `minimumConfidence` (default 0.7), in a lens not permitted for the path, or duplicated. Anything left is a substantiated defect and blocks approval. Rejected drafts do not block.
- **Overall confidence of 4/5 or 5/5.** Zero findings only shows the agent reported nothing. The score records whether it believes coverage and verification were sufficient. A 3/5 review with no findings goes to a person.

`--confidence` is a required integer flag. It must match the score written in the published review context. The CLI refuses below 4 before contacting the service, and the service refuses it again.

Deterministic refusals, which also send a PR to a person: binary changes, files without text patches, protected paths (review config, the review skill, `src/stamp*.ts` and `stamp.denyPaths`), more than `stamp.maxChangedLines`, draft or closed PRs, and stale or partial reviews.

### GitHub App

One organization-owned app, "Review Agent", with **Pull requests: read and write**, **Contents: read** and **Metadata: read**. It has no webhook, user authorization or device flow. Install it on the repositories that should be stamped. The installation is the repository allowlist; the base-branch `stamp.enabled` setting is a second, per-repository opt-in.

Approvals appear as `review-agent[bot]`. The review body names the reviewed base and head, finding count, dropped draft count, confidence, and a link to the published review comment.

Branch protection and rulesets decide whether the approval satisfies merge requirements. The bot approves whenever its gates pass. If the repository also requires code-owner review or another human approval, people handle that manually. Repositories should dismiss stale approvals so new commits require a new review and stamp.

### Service

`review stamp serve` remains an Effect HTTP service, now stateless:

| Setting | Purpose |
| --- | --- |
| `STAMP_PUBLIC_URL` | Full HTTPS endpoint; must match each base branch's `stamp.service` |
| `STAMP_KEY` | Shared approval key, at least 32 characters |
| `GITHUB_APP_ID` | App ID |
| `GITHUB_APP_PRIVATE_KEY` | App private key, from the host's secret manager |

For each request, the service signs an app JWT with `node:crypto` (RS256, short expiry). It resolves `GET /repos/{owner}/{repo}/installation`, then mints an installation token limited to that repository and to `pull_requests: write` and `contents: read`. Tokens live only for the request.

Idempotency comes from GitHub, not a database. Before writing, the service lists the PR's reviews:

- An active bot approval at the reviewed head returns `already-approved`.
- A dismissed bot approval at that head is refused; someone withdrew it intentionally.
- Otherwise it rechecks PR metadata and submits `APPROVE` with `commit_id` set to the head.

Concurrent duplicate requests can at worst produce two approvals from the same bot. They count as one approval. After a timeout, the client can rerun the same command safely, because the service finds the earlier approval.

`GET /api/health` stays unauthenticated. The enroll, users and remove routes, and the enroll and admin keys, are removed.

### CLI

- `review stamp approve` gains the required `--confidence <1-5>` flag and adds `confidence` and the published comment URL to the request. Otherwise it keeps its local gates, `--dry-run`, and the `REVIEW_STAMP_URL`/`REVIEW_STAMP_KEY` trust check.
- The request becomes version 2. The service rejects version 1.
- Remove `review stamp enroll`, `users` and `remove`.
- Remove the obsolete `stamp.team` and `stamp.channel` config fields.

### Agent workflow

Each repository's `AGENTS.md` requires the review on every PR. The skill's Stamp section changes from "only when the user asks" to "when the user or the repository's agent instructions require it." Suggested repository text:

```md
## Review agent

After opening a PR or pushing to one, use the `review` skill to review the whole
current PR, publish the review, and stamp it. Fix accepted findings and repeat.
If the stamp is refused, report the reason and request human review; do not
approve the PR another way.
```

`review setup` can later offer to add this section. Agents still never call `gh pr review --approve` directly.

### Changes

Delete: `src/stamp-store.ts`, `src/stamp-client.ts`, the enrollment and admin parts of `src/stamp-protocol.ts` and `src/stamp-server.ts`, the reviewer-pool loop in `src/stamp-service.ts`, OAuth in `src/stamp-github.ts`, the `@azure/data-tables` dependency, and their tests.

Add or rewrite: app JWT and installation-token minting in `src/stamp-github.ts`, the stateless approve path in `src/stamp-service.ts`, version-2 protocol and confidence gate, `stamp-service/README.md` setup for the app, `references/stamp.md`, the skill's Stamp section, and README.

Tests use fake GitHub responses and cover:

- JWT claims and signature.
- Installation-token scoping.
- Every refusal.
- Confidence below 4.
- `already-approved`, a dismissed approval, and retry after a timeout.

### Rollout

1. On a scratch repository with required approvals, confirm a GitHub App approval counts toward the required review count.
2. Create and install the app. Deploy the service behind HTTPS.
3. Distribute `REVIEW_STAMP_URL` and `REVIEW_STAMP_KEY` through normal secret configuration.
4. Run `--dry-run`, then one real stamp on a test PR.
5. Enable `stamp` in pilot repositories' base-branch config and add the `AGENTS.md` section.

Accepted trade-off: an approval is attested by the requester's local agent. A key holder can stamp their own PR with an empty findings file. The base-branch gates, bot attribution, published review comment and stale-approval dismissal limit and expose that. They do not prevent it. Rotate `STAMP_KEY` when someone leaves.
