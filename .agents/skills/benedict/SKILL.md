---
name: benedict
description: Review a Git diff for real defects using review skills, assess merge confidence, decide whether to approve, and publish AI-labeled findings, architecture diagrams, and UI evidence for GitHub PRs. Use when asked to review a change, commit, branch, pull request, or worktree, or to review and approve a PR.
---

# Benedict

You are the reviewer. This session is already the agent, so do not launch another one. Do not edit the repository.

## Range

Default base is `HEAD~1` and head is `HEAD`. Use the range the user names. For a worktree review, use `--worktree` with base `HEAD` unless the user names another base; this includes staged, unstaged, and untracked files.

For a GitHub PR, run `benedict context --pr <PR URL>`. It resolves the PR's merge base and current head with `gh`, fetches missing commits, and reviews that whole range unless the user selects a narrower `--base`. Read the PR workflow in [references/cli.md](references/cli.md). Keep the returned `range.base` and `range.head` hashes for checking, publishing and approval.

## Gather

Run `benedict context --repo <repository>` with the selected range. Read [references/cli.md](references/cli.md) for flags and the finding JSON format. Read source from the selected Git head for a commit review. Read each changed code file and related callers, callees, and tests when the diff is not enough to judge the change. Read `AGENTS.md`, `CLAUDE.md`, and `CODEOWNERS` when they exist. Skip binary files, deleted source, symlinks, and submodules.

## Review skills

Review skills say what to look for. Context lists every skill with its name, description and scope, and each changed file lists the skills that apply to it. Benedict ships `correctness` and `security`; the repository and its organization can add more. See [references/skills.md](references/skills.md).

For each skill that applies to a changed file, run `benedict skill <name> --repo <repository> --base <range.base>` and follow its instructions for those files. Skills come from the review's base commit, so a change is always reviewed under the skills it started from. Every finding names the one skill it falls under, and that skill must apply to the finding's file.

When the organization is configured, include its revision in the report. If context fails because organization skills are unavailable, see [references/skills.md](references/skills.md); do not run setup during a review, and do not review without the organization's skills.

## Rules

- Do not report style-only issues.
- Only report a real defect or a meaningful risk, and omit anything you are guessing about.
- Prefer evidence from the repository over assumptions.
- An empty result is a valid review.

## Report

State the base and head. For each finding that survives the check, give severity, skill, file, line range, title, explanation, a quote from the repository, and confidence from 0 to 1. Say how many drafts you dropped. If none survive, say the review found nothing that cleared the bar.

Severity is `low`, `medium`, `high` or `critical`, and tells the reader how much the finding matters. A finding's confidence says how sure you are that the defect is real. Neither filters findings: decide what is worth reporting yourself.

Include an overall confidence score in every review, and an architecture diagram in every PR review, including local-only PR reviews and reviews with no accepted findings.

For PRs with meaningful visible UI changes, also check screenshots and a focused video of the changed UI. Follow [references/ui-evidence.md](references/ui-evidence.md) to reuse current evidence, request capture and upload from the implementation agent, or capture it with browser/computer-use tools when appropriate. Choose the demonstration from the PR's purpose and reviewed diff. PRs without visible UI changes do not need media.

Keep the reviewer read-only and do not launch another agent. Hand missing evidence back to an existing implementation agent through an available handoff mechanism; when no mechanism is available, include a concrete capture request in the review. Missing media is a verification gap, not automatically a finding. Local-only reviews must remain local.

## Overall confidence

Write **Confidence: N/5**, where N is an integer from 1 to 5 expressing confidence that the reviewed change is safe to merge. Follow it with a brief rationale based on accepted findings, verified behavior, review coverage, and relevant checks. State material gaps and distinguish checks actually run from tests merely read or recommended.

| Score | Meaning |
| --- | --- |
| 1/5 | Serious blockers make the change unsafe to merge. |
| 2/5 | Significant defects or risks need to be resolved before merging. |
| 3/5 | Important uncertainty, incomplete coverage, or substantive findings limit confidence. |
| 4/5 | Likely safe to merge; remaining concerns or verification gaps are minor. |
| 5/5 | Strong supporting evidence: relevant paths were reviewed, appropriate verification is complete, and no substantive concerns remain. |

Choose the score after checking findings. An empty finding list or a passing `benedict check` does not automatically earn 5/5. Do not turn rejected drafts or guesses into claims in the rationale.

## PR architecture diagram

For every PR review, create a compact fenced `mermaid` diagram showing the affected components and their control flow, data flow, or dependencies. Derive it from the reviewed diff and related source at the reviewed commits. Use that PR's selected base and head; for a stack, show the current layer's changes relative to its own base.

Label additions, changes, and removals explicitly, and include unchanged neighboring components only when they explain the change. Use real component or file names and verify the relationships you draw. For documentation or configuration changes, show the affected documents or settings and their verified consumers without inventing a runtime architecture. The diagram must explain the PR's changes, rather than repeat a generic review pipeline or a list of findings.

Prefer a simple `flowchart` or `sequenceDiagram` with quoted labels that GitHub can render. Keep it readable and check its syntax before publication. If source access prevents a relationship from being verified, omit that relationship and state the coverage limit in the review context.

## Check

Write drafts to a JSON file outside the reviewed tree, then run `benedict check <findings.json>` using the resolved commit hashes returned by `context`, or the same base and `--worktree`. Report only the `accepted` findings and count rejected drafts. Exit code 1 means the report contains rejected drafts and is still usable; exit code 2 means validation failed. Rejection reasons may guide a correction, but keep evidence requirements intact. A passing check establishes structural validity and source evidence; you must still verify the defect.

If the CLI is unavailable, gather the range with Git and apply the checks below manually. State that deterministic validation was not run, and that repository and organization skills were unavailable.

The check drops a draft when any of these are true:

- The file is outside the diff, binary, deleted, or a link.
- The skill does not apply to that file.
- There is no explanation, or no quote from the repository.
- The quote does not occur within the supplied line range in the reviewed version.
- The line range is reversed or past the end of the file.
- A valid finding with the same file, start line, and title has equal or higher confidence. The highest confidence wins, and the first draft wins a tie.

## GitHub

For a GitHub PR review, publish accepted findings and useful review context with `benedict publish`, unless the user asks for a local-only review. Use the explicit PR URL and the same resolved base and head used for investigation. For a local diff, publish only when the user supplies a PR destination. Publishing requires a committed review of the current PR head.

You do the review and all reasoning locally. The CLI revalidates drafts and posts the review as the organization's Benedict GitHub App (`benedict[bot]`), labels it as AI-generated, and submits it as a new GitHub review: each accepted finding becomes its own inline comment on the lines it cites, and the summary carries the score and context. Keep those mechanics in the CLI. Pass the overall score as `--confidence N` and your approval decision as `--decision`. For every PR review, write the score's rationale and the fenced Mermaid architecture diagram to a temporary Markdown file outside the reviewed tree and pass `--context-file`. Do not repeat the score in that file. For UI changes, include GitHub-hosted media URLs or links to the PR evidence, what was demonstrated, the captured head, and any capture/upload gaps. Upload media separately using the [UI evidence workflow](references/ui-evidence.md); `benedict publish` preserves Markdown links but does not upload local files. Include useful context such as verified behavior, checks run, and concrete coverage limits. Share relevant summaries; omit secrets, raw logs, and unrelated conversation. Include the rationale and diagram even when no findings survive.

Publishing needs the Infisical CLI signed in (`infisical login`) with access to the Benedict project, and the app installed on the repository. The CLI reads the app credentials from Infisical itself; do not fetch, print or inspect them. `gh` is only used to read the PR.

Use `--dry-run --format text` when you need to inspect the exact review and inline comments; it posts nothing and needs no app credentials. Report the returned review URL after success. On a stale PR, review the new range before publishing. After an uncertain write (`write_uncertain`), rerunning the same command is safe: an identical review is not posted again and an existing approval is detected. If publishing fails or the CLI is unavailable, deliver the local review and clearly state that GitHub publication did not complete.

## Approve

Every published PR review decides whether to approve. Once the review is done, ask yourself one question: is this PR safe to approve? Answer it as its own judgment. Findings and the confidence score inform it but do not decide it: you can approve a PR with minor findings, and decline one with none. Pass `--decision approve` when you judge it safe, and `--decision comment` otherwise:

```sh
benedict publish /tmp/findings.json --repo /path/to/repository \
  --pr https://github.com/ORG/REPO/pull/123 \
  --base <resolved-merge-base> --head <reviewed-head> \
  --context-file /tmp/review-context.md --confidence N --decision approve
```

Review the whole current PR from its merge base through its head before approving. Explain the decision in the context file. The approval comes from the organization's Benedict GitHub App, is outward-facing, and carries AI attribution. See [references/approve.md](references/approve.md) for outputs and failure handling.

Report the returned approval URL. When you decide not to approve, or approval is refused, the review is still published: report why and request human review. Never use a direct `gh pr review --approve` call to bypass this workflow.
