# CLI and finding format

Use the installed `review` executable. Run `review --help` or `review <command> --help` for command usage.

## Context

```sh
review context --repo /path/to/project --base HEAD~1 --head HEAD
review context --repo /path/to/project --worktree
```

JSON is the default output. `--format text` produces a readable summary. Both commands accept `--repo`, `--base`, `--head`, `--worktree`, `--config`, and `--format`. `--worktree` and `--head` cannot be combined.

The default commit range is `HEAD~1` to `HEAD`; the default worktree base is `HEAD`. The context contains resolved commit hashes, changed files, patches, line counts, changed lines, permitted correctness/security lenses, and repository rules. Commit source comes from Git. Worktree source is the current on-disk content, including staged, unstaged, and untracked files that Git does not ignore.

Config and repository knowledge are read from the current working tree. Organization knowledge is read from the exact cached revision in `.review/knowledge.lock.json`. Context returns resolved policy and knowledge documents, including their scope. Path globs match repository-relative paths using forward slashes. Matching rules combine their permitted lenses, intersected with the global `skills` list; unmatched paths use that global list. Organization-required lenses always apply; an empty list disables only optional lenses. `--config` selects a config relative to the repository root, or accepts an absolute path.

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
review check /tmp/findings.json --repo /path/to/project --base <resolved-base-hash> --head <resolved-head-hash>
review check /tmp/findings.json --repo /path/to/project --base <resolved-base-hash> --worktree
```

Use the same policy and Git range as `context`. Commit hashes prevent branch movement from changing the reviewed source. For a worktree review, source is read again on each command invocation; repeat the investigation if files change.

`check` outputs `accepted`, `rejected`, and `summary`. Rejected drafts retain their original zero-based `index` and contain reason codes and messages. Defaults are minimum severity `medium` and minimum confidence `0.7`. Duplicate findings use the same file, start line, and title; the highest valid confidence wins, and ties keep the first.

- Exit 0: all drafts passed, including an empty list.
- Exit 1: validation completed and some drafts were rejected. Read the report.
- Exit 2: input, configuration, Git, or command failure. Do not claim successful validation.

Report the resolved base and head, accepted findings, and rejected count. Keep the coding agent's judgment separate from mechanical validation: exact evidence and sufficient confidence do not by themselves prove a bug.

The skill also requires an overall **Confidence: N/5** with a rationale. This is confidence that the reviewed change is safe to merge, and follows the rubric in [SKILL.md](../SKILL.md#overall-confidence). Keep it in the Markdown report; the JSON finding field `confidence` remains a number from 0 to 1.

When organization knowledge is configured, include the source and organization revision from the check report. Read [knowledge.md](knowledge.md) for inheritance and cache failures. Setup and sync are onboarding/update operations, separate from the read-only review workflow.

## GitHub PR workflow

Requires the GitHub CLI (`gh`) installed and signed in to `github.com` with access to the destination PR. Use a full `https://github.com/OWNER/REPO/pull/NUMBER` URL. Obtain the PR's base and head hashes:

```sh
gh api --hostname github.com repos/OWNER/REPO/pulls/NUMBER --jq '.base.sha, .head.sha'
git merge-base <pr-base-hash> <pr-head-hash>
review context --repo /path/to/project --base <merge-base-hash> --head <pr-head-hash>
```

The commits must exist in the local repository. Fetch the base and PR head if necessary. Investigate that resolved range, then use the same hashes with `check` and `publish`. A user-selected narrower range may start at an ancestor of the PR head within the PR range.

```sh
review publish /tmp/findings.json --repo /path/to/project \
  --pr https://github.com/OWNER/REPO/pull/NUMBER \
  --base <reviewed-base-hash> --head <reviewed-head-hash> \
  --context-file /tmp/review-context.md --dry-run --format text

# Omit --dry-run to write the review to GitHub.
review publish /tmp/findings.json --repo /path/to/project \
  --pr https://github.com/OWNER/REPO/pull/NUMBER \
  --base <reviewed-base-hash> --head <reviewed-head-hash> \
  --context-file /tmp/review-context.md
```

`publish` takes the original draft findings format, revalidates it, and posts only accepted findings plus the rejected count. The CLI accepts `--context-file` as optional, but the skill requires it for PR publication. Write the overall **Confidence: N/5**, a brief rationale and verification gaps, and a fenced `mermaid` architecture diagram of the reviewed PR into that file, even when the findings array is empty. Follow the [diagram guidance](../SKILL.md#pr-architecture-diagram); derive the diagram from this PR's code and changes. Markdown and Mermaid fences are preserved in the PR comment. The CLI validates findings; the agent owns the score, diagram accuracy, and Mermaid syntax.

Files resolve from the shell's current directory. Config uses the same `--config` flag and repository-relative resolution as `check`. With no explicit range, the base is the PR merge base and the head is local `HEAD`. Publication rejects a head that differs from the current PR, and does not accept `--worktree`.

For meaningful UI changes, follow [UI evidence guidance](ui-evidence.md): check existing screenshots and focused video, request missing evidence from the implementation agent, and include the uploaded media URLs or evidence-comment link, demonstrated scenario, captured head, and any gaps in the context file. `publish` preserves Markdown links; it does not capture or upload media, and a local filesystem path will not become a GitHub attachment. Local-only reviews do not upload or publish evidence.

Every comment starts with **AI-generated review** and identifies the review skill and CLI automated reviewer. GitHub still displays the signed-in account as the uploader. The comment includes resolved commits, accepted findings, severity, lens, confidence, source links, evidence, suggested fixes when present, and optional context. Rejected draft contents and local repository paths stay out of the comment.

One PR conversation comment is maintained per signed-in account. The CLI paginates comments and updates only a comment by that account starting with its automation marker. Unchanged content makes no write; multiple matching comments cause an error. PR metadata is rechecked before writing. Concurrent publishers can still race; run publishing sequentially for an account and PR. GitHub does not make the final metadata check and comment write atomic, so the comment always identifies the reviewed commit.

JSON output contains `action` (`dry-run`, `created`, `updated`, or `unchanged`), `pr`, `commentUrl`, `range`, `summary`, and the exact `body`. Text output shows the action, destination, and body. Exit 0 means preview or publication succeeded, including when some drafts were dropped. Exit 2 means publication failed; GitHub writes are never automatically retried. A lost response may hide a successful write: inspect the PR before retrying. An ordinary repeat run discovers the existing marked comment. Comments above 60,000 bytes fail so the agent can shorten the content.

`--dry-run` reads PR metadata and validates locally, without writing to GitHub. It still requires `gh` authentication. If `gh` is unavailable or publication fails, report the local findings and publication failure without claiming that a comment was posted.
