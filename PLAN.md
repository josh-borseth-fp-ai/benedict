# Plan

Build Benedict, a portable review skill backed by a deterministic Effect TypeScript CLI. Any coding agent can follow the skill and run the commands.

## Responsibilities

The skill guides investigation: read the change, trace related code, apply correctness and security, and establish whether a suspected defect is real. It also assesses merge confidence on a five-point scale and diagrams the affected architecture for each PR. Individual finding confidence remains on the 0–1 scale.

`benedict context` resolves a Git range and returns changed files, patches, line counts, changed lines, applicable lenses, and repository rules. Commit reviews use source from Git; worktree reviews include staged, unstaged, and untracked files.

`benedict check` validates finding structure, diff membership, file type, source line ranges, quoted evidence, permitted lenses, severity and confidence thresholds, and duplicate findings. It returns accepted findings and rejected drafts with reasons.

`benedict setup` installs the bundled skill through Vercel's skills CLI, optionally connects a repository to organization knowledge, and records its initial revision. `benedict sync` restores that locked revision into a local cache; `--update` explicitly adopts a newer version.

Repository policy (`.benedict/config.json`) and Markdown knowledge live alongside the code. Organization defaults, required constraints, and shared documents live in an organization-owned Git repository's `.benedict/organization.json`, using the same policy field names. `.benedict/knowledge.lock.json` records the selected source and commit. Review commands use that exact cache offline and include its revision in their output.

`benedict publish` reuses that validator, verifies the PR range, and sends the validated review to the Benedict service, which renders a fixed AI attribution and posts a Benedict GitHub App review with one inline comment per finding. The skill selects useful findings and context; deterministic code owns formatting, destination checks, and API operations.

## Pipeline

```
Coding agent loads the skill
  → benedict context
  → investigate changed and related code
  → write draft findings
  → benedict check
  → report accepted findings, dropped draft count, and overall confidence out of five
  → for a PR, diagram its changed architecture and write score, rationale, and Mermaid to Markdown context
  → benedict publish for GitHub PR reviews, unless local-only
```

## Boundaries

The existing coding agent owns investigation and judgment. Review commands read the repository, run Git, and check mechanical constraints. Setup and sync explicitly write installation/configuration/lock state; they never change application source or execute organization code. GitHub reads use GitHub CLI, which owns its authentication; every GitHub write goes through the Benedict service as the GitHub App. All AI inference runs locally in the developer's coding agent; the service never runs a model. The CLI does not launch another agent or handle provider credentials. Passing validation does not prove that a finding describes a real bug.

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

Add targeted retrieval or additional conditional review lenses when real reviews demonstrate a need. Keep provider orchestration, autonomous edits, and a vector database outside the project scope. The Benedict service below is the shared approval component.

## Benedict service and approval

The developer's local coding agent reviews every PR. A small stateless service posts the review and, when requested, the approval as a single GitHub App. Nothing posts from a developer's GitHub account, and no AI inference runs in the cloud.

### Flow

```
Local agent follows the repository's AGENTS.md
  → benedict context, investigate, benedict check
  → benedict publish --confidence N [--approve]
      local: revalidate findings, verify the range against the PR via gh (read-only)
  → POST BENEDICT_SERVICE_URL/api/reviews with x-benedict-key
  → Benedict service
      authenticates the key, mints an installation token for the one repository,
      checks the PR is open, the head is current and the base is inside the PR,
      reads the PR patches, renders the summary and one inline comment per finding
  → with --approve: checks the approval gates and for an existing bot approval
  → POST /pulls/N/reviews as benedict[bot] at the reviewed head:
      APPROVE when the gates pass, otherwise COMMENT
```

The service trusts the caller's review. It does not run a model; the local agent owns investigation and judgment. An approval means a key holder's agent reviewed the whole current PR and reported no blocking defects, under rules fixed by the base branch.

### Why the app posts the review

- **Attribution.** The review, its comments and the approval all come from `benedict[bot]`, so a clean review on your own PR does not look like self-review.
- **One record.** An approval is the review the service itself just wrote, rather than a comment the developer's account could edit.
- **Comments where the code is.** Each finding is an inline comment on the lines it cites, so it can be discussed and resolved like a person's comment. Findings on unchanged lines stay in the summary.
- **History per round.** Each publication with new content is a new review, so earlier rounds stay visible.
- **Simpler flow.** One command publishes and approves.

### Approval criteria

Both are required:

- **Zero accepted findings.** `benedict check` removes drafts outside the diff, without matching evidence, below `severity.minimum` (default medium), below `minimumConfidence` (default 0.7), in a lens not permitted for the path, or duplicated. Anything left is a substantiated defect and blocks approval. Rejected drafts do not block.
- **Overall confidence of 4/5 or 5/5.** Zero findings only shows the agent reported nothing. The score records whether it believes coverage and verification were sufficient. A 3/5 review with no findings goes to a person.

`--confidence` is a required integer flag on `publish`. The service renders it into the review summary and applies the approval threshold to it.

Deterministic approval refusals, which also send a PR to a person: binary changes, files without text patches, protected paths (review config, the Benedict skill and `approve.denyPaths`), more than `approve.maxChangedLines`, draft PRs, and partial reviews. A refused approval still publishes the review and is reported in the response. Closed PRs, stale heads and ranges outside the PR fail the whole request.

### GitHub App

One organization-owned app, "Benedict", with **Pull requests: read and write**, **Contents: read** and **Metadata: read**. It has no webhook, user authorization or device flow. Install it on the repositories it should review. The installation is the repository allowlist; the base-branch `approve.enabled` setting is a second, per-repository opt-in for approvals.

Reviews, inline comments and approvals appear as `benedict[bot]`. An approving review's summary names the reviewed base and head, finding count, dropped draft count and confidence.

Branch protection and rulesets decide whether the approval satisfies merge requirements. The bot approves whenever its gates pass. If the repository also requires code-owner review or another human approval, people handle that manually. Repositories should dismiss stale approvals so new commits require a new review and approval.

### Service

`benedict serve` is a stateless Effect HTTP service:

| Setting | Purpose |
| --- | --- |
| `BENEDICT_SERVICE_KEY` | Shared service key, at least 32 characters |
| `GITHUB_APP_ID` | App ID |
| `GITHUB_APP_PRIVATE_KEY` | App private key, from the host's secret manager |

For each request, the service signs an app JWT with `node:crypto` (RS256, short expiry). It resolves `GET /repos/{owner}/{repo}/installation`, then mints an installation token limited to that repository and to `pull_requests: write` and `contents: read`. Tokens live only for the request.

Idempotency comes from GitHub, not a database:

- Each review summary carries a digest of its content. A bot review at the reviewed head with the same digest means the review already landed, and no write is made.
- An active bot approval at the reviewed head returns `already-approved`.
- A dismissed bot approval at that head is refused; someone withdrew it intentionally.
- Otherwise it rechecks PR metadata and submits the review with `commit_id` set to the head.

Concurrent duplicate requests can at worst produce two identical reviews or two approvals from the same bot. Duplicate approvals count as one. After a timeout, the client can rerun the same command safely.

`POST /api/reviews` is the only authenticated route. `GET /api/health` stays unauthenticated.

### Agent workflow

Each repository's `AGENTS.md` requires the review on every PR. Suggested repository text:

```md
## Benedict

After opening a PR or pushing to one, use the `benedict` skill to review the whole
current PR, publish the review, and request approval. Fix accepted findings and
repeat. If approval is refused, report the reason and request human review; do
not approve the PR another way.
```

`benedict setup` can later offer to add this section. Agents never call `gh pr review --approve` directly.

### Rollout

1. On a scratch repository with required approvals, confirm a GitHub App approval counts toward the required review count.
2. Create and install the app. Deploy the service behind HTTPS.
3. Distribute `BENEDICT_SERVICE_URL` and `BENEDICT_SERVICE_KEY` through normal secret configuration.
4. Run `publish --dry-run`, then one real publish and approval on a test PR.
5. Enable `approve` in pilot repositories' base-branch config and add the `AGENTS.md` section.

Accepted trade-offs: an approval is attested by the requester's local agent. A key holder can approve their own PR with an empty findings file, and can post any review text as the bot. The base-branch gates, bot attribution, the published review and stale-approval dismissal limit and expose that. They do not prevent it. With a shared key the service cannot tell which developer published. Rotate `BENEDICT_SERVICE_KEY` when someone leaves.
