---
name: review
description: Review a Git diff for real correctness and security defects, assess merge confidence, and publish AI-labeled findings, architecture diagrams, and UI evidence for GitHub PRs. Use when asked to review a change, commit, branch, pull request, or worktree, or to review and stamp a PR.
---

# Review

You are the reviewer. This session is already the agent, so do not launch another one. Do not edit the repository.

## Range

Default base is `HEAD~1` and head is `HEAD`. Use the range the user names. For a worktree review, use `--worktree` with base `HEAD` unless the user names another base; this includes staged, unstaged, and untracked files.

For a GitHub PR, run `review context --pr <PR URL>`. It resolves the PR's merge base and current head with `gh`, fetches missing commits, and reviews that whole range unless the user selects a narrower `--base`. Read the PR workflow in [references/cli.md](references/cli.md). Keep the returned `range.base` and `range.head` hashes for checking, publishing and stamping.

## Gather

Run `review context --repo <repository>` with the selected range. Read [references/cli.md](references/cli.md) for flags and the finding JSON format. Use the returned patches and permitted lenses, and read source from the selected Git head for a commit review. Read each changed code file and related callers, callees, and tests when the diff is not enough to judge the change. Read `AGENTS.md`, `CLAUDE.md`, and `CODEOWNERS` when they exist. Skip binary files, deleted source, symlinks, and submodules.

The CLI reads `.review/config.json` from the repository. Review configuration is JSON only. For each changed file, apply only the lenses permitted by the returned policy. Unmatched paths use the global `skills` list, which defaults to correctness and security. An empty list disables optional checks; organization-required lenses still apply. Fix input or configuration errors before relying on a check result.

Read the `config.knowledge` documents returned by context. They identify repository and organization scope. Organization defaults can be overridden by repository settings; organization-required lenses, thresholds, and rules remain applicable. Include the organization revision in the report when present. See [references/knowledge.md](references/knowledge.md) when knowledge or policy resolution fails. A missing required lock/cache prevents validated review; do not silently omit organization guidance or use a different revision.

```json
{
  "skills": ["correctness", "security"],
  "minimumSeverity": "medium",
  "minimumConfidence": 0.7,
  "paths": [{ "pattern": "api/**", "skills": ["security"] }],
  "rules": ["Do not report style-only issues."]
}
```

`api/**` matches `api/v1/user.ts` and does not match `web/api/user.ts`. `*.ts` does not match `src/user.ts`. When several rules match, an optional lens applies only if the global `skills` list includes it and a matching rule lists it. Organization-required lenses apply regardless of path rules.

## Correctness

Broken control flow, incorrect assumptions, null or undefined cases, state inconsistencies, missing error handling, edge cases, and regressions caused by this diff.

## Security

Auth or authz mistakes, injection, secret exposure, unsafe deserialization, trust-boundary violations, and insecure defaults caused by this diff.

## Rules

Follow `rules` from the review config. When the file is missing:

- Do not report style-only issues.
- Only report a real defect or a meaningful risk.
- Prefer evidence from the repository over assumptions.

## Report

State the base and head. For each finding that survives the check, give severity, skill, file, line range, title, explanation, a quote from the repository, and confidence from 0 to 1. Say how many drafts you dropped. If none survive, say the review found nothing that cleared the bar.

Include an overall confidence score in every review, and an architecture diagram in every PR review, including local-only PR reviews and reviews with no accepted findings.

For PRs with meaningful visible UI changes, also check screenshots and a focused video of the changed UI. Follow [references/ui-evidence.md](references/ui-evidence.md) to reuse current evidence, request capture and upload from the implementation agent, or capture it with browser/computer-use tools when appropriate. Choose the demonstration from the PR's purpose and reviewed diff. PRs without visible UI changes do not need media.

Keep the reviewer read-only and do not launch another agent. Hand missing evidence back to an existing implementation agent through an available handoff mechanism; when no mechanism is available, include a concrete capture request in the review. Missing media is a verification gap, not automatically a correctness/security finding. Local-only reviews must remain local.

## Overall confidence

Write **Confidence: N/5**, where N is an integer from 1 to 5 expressing confidence that the reviewed change is safe to merge. Follow it with a brief rationale based on accepted findings, verified behavior, review coverage, and relevant checks. State material gaps and distinguish checks actually run from tests merely read or recommended.

| Score | Meaning |
| --- | --- |
| 1/5 | Serious blockers make the change unsafe to merge. |
| 2/5 | Significant defects or risks need to be resolved before merging. |
| 3/5 | Important uncertainty, incomplete coverage, or substantive findings limit confidence. |
| 4/5 | Likely safe to merge; remaining concerns or verification gaps are minor. |
| 5/5 | Strong supporting evidence: relevant paths were reviewed, appropriate verification is complete, and no substantive concerns remain. |

Choose the score after checking findings. An empty finding list or a passing `review check` does not automatically earn 5/5. Do not turn rejected drafts or guesses into claims in the rationale. This overall score is separate from each finding's 0–1 confidence and the configured `minimumConfidence`; those continue to measure confidence in the individual defect.

## PR architecture diagram

For every PR review, create a compact fenced `mermaid` diagram showing the affected components and their control flow, data flow, or dependencies. Derive it from the reviewed diff and related source at the reviewed commits. Use that PR's selected base and head; for a stack, show the current layer's changes relative to its own base.

Label additions, changes, and removals explicitly, and include unchanged neighboring components only when they explain the change. Use real component or file names and verify the relationships you draw. For documentation or configuration changes, show the affected documents or settings and their verified consumers without inventing a runtime architecture. The diagram must explain the PR's changes, rather than repeat a generic review pipeline or a list of findings.

Prefer a simple `flowchart` or `sequenceDiagram` with quoted labels that GitHub can render. Keep it readable and check its syntax before publication. If source access prevents a relationship from being verified, omit that relationship and state the coverage limit in the review context.

## Check

Write drafts to a JSON file outside the reviewed tree, then run `review check <findings.json>` using the resolved commit hashes returned by `context`, or the same base and `--worktree`. Report only the `accepted` findings and count rejected drafts. Exit code 1 means the report contains rejected drafts and is still usable; exit code 2 means validation failed. Rejection reasons may guide a correction, but keep thresholds and evidence requirements intact. A passing check establishes structural validity and source evidence; you must still verify the defect.

If the CLI is unavailable, gather the range with Git and apply the checks below manually. State that deterministic validation was not run. When the repository declares organization knowledge, also disclose any unavailable organization guidance.

Drop a draft when any of these are true:

- The file is outside the diff or is binary.
- The skill is not allowed for that path.
- There is no explanation, or no quote from the repository.
- The quote does not occur within the supplied line range in the reviewed version.
- The line range is reversed or past the end of the file.
- Severity is below the config `minimumSeverity`. Default is `medium`. Rank is low, medium, high, critical.
- Confidence is below `minimumConfidence`. Default is 0.7.
- A valid finding with the same file, start line, and title has equal or higher confidence. Keep the highest confidence and the first draft on a tie.

Omit anything you are guessing about. An empty result is a valid review.

## GitHub

For a GitHub PR review, publish accepted findings and useful review context with `review publish`, unless the user asks for a local-only review. Use the explicit PR URL and the same resolved base, head, and config used for investigation. For a local diff, publish only when the user supplies a PR destination. Publishing requires a committed review of the current PR head.

The CLI revalidates drafts, labels the comment as AI-generated by the review skill and CLI, and updates its own marked comment through `gh`. Keep those mechanics in the CLI. For every PR review, write the overall confidence score, its rationale, and the fenced Mermaid architecture diagram to a temporary Markdown file outside the reviewed tree and pass `--context-file`. For UI changes, include GitHub-hosted media URLs or links to the PR evidence, what was demonstrated, the captured head, and any capture/upload gaps. Upload media separately using the [UI evidence workflow](references/ui-evidence.md); `review publish` preserves Markdown links but does not upload local files. Include useful context such as verified behavior, checks run, and concrete coverage limits. Keep the score, diagram, and UI evidence in Markdown rather than adding fields to finding JSON. Share relevant summaries; omit secrets, raw logs, and unrelated conversation. Include both the score and diagram even when no findings survive.

Use `--dry-run --format text` when you need to inspect the exact comment. Report the returned comment URL after success. On a stale PR, review the new range before publishing. On a GitHub write error, inspect the PR before retrying because the write may have succeeded. If publishing fails or the CLI is unavailable, deliver the local review and clearly state that GitHub publication did not complete.

## Stamp

Only stamp when the user asks you to review and stamp a GitHub PR. A stamp directly submits a GitHub approval through the shared, opted-in reviewer pool. It is outward-facing and carries AI attribution.

Review the whole current PR from its merge base through its head, publish the review as above, then run:

```sh
review stamp approve /tmp/findings.json --repo /path/to/repository \
  --pr https://github.com/ORG/REPO/pull/123 \
  --base <resolved-merge-base> --head <reviewed-head>
```

Pass the original draft findings and the same resolved hashes/config used by `context` and `check`. The CLI revalidates findings and requires no accepted findings. It reads stamp authorization, the service endpoint, protected paths and the size limit from the PR's base commit. `--dry-run` previews the request without contacting the stamp service.

The base branch must configure `stamp.enabled` and `stamp.service`, and the user must have configured `REVIEW_STAMP_URL` and `REVIEW_STAMP_KEY` for the service. The trusted local URL must match the base config before the CLI sends the key. The CLI owns authentication; do not print or inspect the key. See [references/stamp.md](references/stamp.md) for setup, outputs and failure handling.

The service independently checks the current whole-PR range, base-branch stamp policy and repository allowlist. It excludes the PR author and submits the approval as an opted-in GitHub reviewer, with the exact reviewed commit and Review Agent attribution. No Teams connection or local MCP is needed.

Report the returned approval URL and approving account. If refused or the request fails, report the reason and stop. An uncertain write is not automatically retried; inspect GitHub before another attempt. Never use a direct `gh pr review --approve` call to bypass this workflow.
