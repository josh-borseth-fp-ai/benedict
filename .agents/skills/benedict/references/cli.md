# CLI and finding format

Use the installed `benedict` executable. Run `benedict --help` or `benedict <command> --help` for command usage. If it is not installed, ask the user to install it with `npm install --global https://github.com/josh-borseth-fp-ai/benedict/releases/latest/download/benedict.tgz`.

## Context

```sh
benedict context --repo /path/to/project --base HEAD~1 --head HEAD
benedict context --repo /path/to/project --worktree
```

JSON is the default output. `--format text` produces a readable summary. Both commands accept `--repo`, `--base`, `--head`, `--worktree`, `--config`, and `--format`. `--worktree` and `--head` cannot be combined. `context` also accepts `--pr` for a GitHub PR; see the [GitHub PR workflow](#github-pr-workflow).

The default commit range is `HEAD~1` to `HEAD`; the default worktree base is `HEAD`. The context contains resolved commit hashes, changed files, patches, line counts, changed lines, permitted correctness/security lenses, and repository rules. Commit source comes from Git. Worktree source is the current on-disk content, including staged, unstaged, and untracked files that Git does not ignore.

Config and repository knowledge are read from the current working tree. Organization knowledge is read from the exact cached revision in `.benedict/knowledge.lock.json`. Context returns resolved policy and knowledge documents, including their scope. Path globs match repository-relative paths using forward slashes. Matching rules combine their permitted lenses, intersected with the global `skills` list; unmatched paths use that global list. Organization-required lenses always apply; an empty list disables only optional lenses. Config defaults to `.benedict/config.json`; `--config` selects another JSON file relative to the repository root, or accepts an absolute path.

## Draft findings

Write an array of findings or an object with a `findings` array to a temporary JSON file outside the reviewed tree:

```json
{
  "findings": [
    {
      "file": "src/example.ts",
      "startLine": 8,
      "endLine": 9,
      "severity": "medium",
      "skill": "correctness",
      "title": "Concrete defect title",
      "explanation": "Describe the trigger and impact, supported by the repository.",
      "quote": "An exact excerpt from these source lines",
      "confidence": 0.85,
      "suggestedFix": "Optional description of the correction"
    }
  ]
}
```

Use the exact repository-relative file path reported by `context`. Lines are positive, inclusive, and refer to the selected head or current worktree. A quote must occur within that range; CRLF is normalized to LF for comparison. Severity is `low`, `medium`, `high`, or `critical`. Skill is `correctness` or `security`. Confidence is a finite number from 0 to 1. Title, explanation, and quote must contain text. Extra finding fields are rejected. `suggestedFix` may be omitted.

## Check and report

```sh
benedict check /tmp/findings.json --repo /path/to/project --base <resolved-base-hash> --head <resolved-head-hash>
benedict check /tmp/findings.json --repo /path/to/project --base <resolved-base-hash> --worktree
```

Use the same policy and Git range as `context`. Commit hashes prevent branch movement from changing the reviewed source. For a worktree review, source is read again on each command invocation; repeat the investigation if files change.

`check` outputs `accepted`, `rejected`, and `summary`. Rejected drafts retain their original zero-based `index` and contain reason codes and messages. Defaults are minimum severity `medium` and minimum confidence `0.7`. Duplicate findings use the same file, start line, and title; the highest valid confidence wins, and ties keep the first.

- Exit 0: all drafts passed, including an empty list.
- Exit 1: validation completed and some drafts were rejected. Read the report.
- Exit 2: input, configuration, Git, or command failure. Do not claim successful validation.

Report the resolved base and head, accepted findings, and rejected count. Keep the coding agent's judgment separate from mechanical validation: exact evidence and sufficient confidence do not by themselves prove a bug.

The skill also requires an overall **Confidence: N/5** with a rationale. This is confidence that the reviewed change is safe to merge, and follows the rubric in [SKILL.md](../SKILL.md#overall-confidence). Keep it in the Markdown report, and pass it to `publish` as `--confidence`; the JSON finding field `confidence` remains a number from 0 to 1.

When organization knowledge is configured, include the source and organization revision from the check report. Read [knowledge.md](knowledge.md) for inheritance and cache failures. Setup and sync are onboarding/update operations, separate from the read-only review workflow.

## GitHub PR workflow

Requires the GitHub CLI (`gh`) installed and signed in to `github.com` with read access to the destination PR. Publishing also requires `BENEDICT_SERVICE_URL` and `BENEDICT_SERVICE_KEY`, and the Benedict GitHub App installed on the repository. Use a full `https://github.com/OWNER/REPO/pull/NUMBER` URL:

```sh
benedict context --repo /path/to/project --pr https://github.com/OWNER/REPO/pull/NUMBER
```

`--pr` reads the PR's current base and head with `gh`, reviews their merge base through the PR head, and reports the resolved hashes in `range` and the PR in `pullRequest.url`. The diff and source still come from local Git. If either commit is missing locally, the CLI fetches the PR head and base branch from the remote whose URL points to `github.com/OWNER/REPO`, without moving local branches or changing files. With no matching remote, add one or fetch the commits yourself. `--pr` cannot be combined with `--head` or `--worktree`. A user-selected narrower range may pass `--base` with an ancestor of the PR head inside the PR range.

Investigate that resolved range, then pass the returned `range.base` and `range.head` hashes to `check` and `publish`. Do not pass `--pr` to `check`: the PR head may move during the review, and the fixed hashes keep the reviewed source unchanged.

```sh
benedict publish /tmp/findings.json --repo /path/to/project \
  --pr https://github.com/OWNER/REPO/pull/NUMBER \
  --base <reviewed-base-hash> --head <reviewed-head-hash> \
  --context-file /tmp/review-context.md --confidence 4 --dry-run --format text

# Omit --dry-run to post the review as the Benedict GitHub App.
benedict publish /tmp/findings.json --repo /path/to/project \
  --pr https://github.com/OWNER/REPO/pull/NUMBER \
  --base <reviewed-base-hash> --head <reviewed-head-hash> \
  --context-file /tmp/review-context.md --confidence 4
```

`publish` takes the original draft findings format, revalidates it, and posts only accepted findings plus the rejected count. `--confidence` is the required overall 1–5 score; the review summary states it as **Overall confidence: N/5**. The CLI accepts `--context-file` as optional, but the skill requires it for PR publication. Write the score's rationale and verification gaps, and a fenced `mermaid` architecture diagram of the reviewed PR into that file, even when the findings array is empty. Follow the [diagram guidance](../SKILL.md#pr-architecture-diagram); derive the diagram from this PR's code and changes. Markdown and Mermaid fences are preserved in the review summary. The CLI validates findings; the agent owns the score, diagram accuracy, and Mermaid syntax.

Files resolve from the shell's current directory. Config uses the same `--config` flag and repository-relative resolution as `check`. With no explicit range, the base is the PR merge base and the head is local `HEAD`. Publication rejects a head that differs from the current PR, and does not accept `--worktree`.

For meaningful UI changes, follow [UI evidence guidance](ui-evidence.md): check existing screenshots and focused video, request missing evidence from the implementation agent, and include the uploaded media URLs or evidence-comment link, demonstrated scenario, captured head, and any gaps in the context file. `publish` preserves Markdown links; it does not capture or upload media, and a local filesystem path will not become a GitHub attachment. Local-only reviews do not upload or publish evidence.

After local validation, the CLI sends the validated review to the Benedict service at `BENEDICT_SERVICE_URL` with the key in a header. The service renders the same review and posts it as the Benedict GitHub App, so GitHub shows `benedict[bot]` as the author. It does not run a model. The review is one GitHub PR review at the reviewed head:

- Each accepted finding is its own inline comment on the lines it cites, with its title, severity, lens, confidence, explanation and suggested fix when present. GitHub only accepts inline comments on lines in the PR diff; a finding that partly overlaps a diff hunk is anchored to the overlapping lines.
- The summary starts with **AI-generated review** and identifies **Benedict**. It includes the resolved commits, finding counts, the overall confidence and optional context. Findings that do not touch the diff are listed there under **Findings outside the diff**, with source links and evidence.

Rejected draft contents and local repository paths stay out of the review. The service checks that the PR is open, that the reviewed head is the current PR head and that the reviewed base lies inside the PR. Each publication with new content posts a new review; earlier reviews stay on the PR. Rerunning an identical review at the same head makes no write. PR metadata is rechecked before writing.

Add `--approve` to also request the app's approval; see [approve.md](approve.md).

JSON output contains `action` (`dry-run`, `created`, or `unchanged`), `pr`, `reviewUrl`, `postedBy`, `approval`, `range`, `summary`, `confidence`, the exact summary `body`, and `comments`: each inline comment's `path`, `startLine`, `line` and `body`. Text output shows the action, destination, any approval outcome, the summary and each inline comment. Exit 0 means preview or publication succeeded, including when some drafts were dropped. Exit 1 means the review was published but a requested approval was refused. Exit 2 means publication failed; the CLI never automatically retries. After an uncertain `service_error`, rerunning the same command is safe. A summary or inline comment above 60,000 bytes fails so the agent can shorten the content.

`--dry-run` reads the PR and its changed-file patches and validates locally without contacting the service, so it needs `gh` but not the service settings. If publication fails, report the local findings and publication failure without claiming that a review was posted.
