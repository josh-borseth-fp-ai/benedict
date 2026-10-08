# Repository and organization knowledge

Repository `review.yaml`, `review.yml`, or `review.json` can add `knowledge`, an array of repository-relative Markdown paths, and `organization`, an object with a Git `source` and optional `ref` (default `HEAD`). Sources support HTTPS, SSH, file URLs, and local repository paths. Git owns authentication; embedded URL passwords and HTTPS usernames are rejected. Refs must select one branch, tag, or commit, not a wildcard/refspec.

The organization repository must contain exactly one `review.yaml`, `review.yml`, or `review.json` manifest. Its fields are:

- `defaults`: optional `skills`, `severity.minimum`, `minimumConfidence`, `paths`, and `rules`, using the same shapes as repository policy.
- `required`: optional `skills`, `minimumSeverity`, `minimumConfidence`, and `rules`.
- `knowledge`: optional array of repository-relative Markdown paths.

Repository fields replace corresponding organization defaults when present. Required global lenses cannot be removed; required lenses also survive path narrowing. Repository severity/confidence floors below requirements are errors. When no repo floor is specified, inherited/default values are raised to meet requirements. Required rules are appended and deduplicated after defaults or repo rules. Free-text rules and document guidance require agent judgment; the validator mechanically enforces lenses and numeric thresholds.

Knowledge documents from both scopes appear in `context.config.knowledge` as `{scope, path, content}`. The organization revision appears in `context.config.organization` and `check.organization`. Repository documents come from the current working tree, including for commit reviews. Organization documents come from Git blobs at the locked revision. Files must be regular Markdown text files of at most 256 KiB each; traversal, symlinks, and binary content are rejected. Organization code is never checked out or executed.

## Setup and synchronization

`review setup` installs this release's bundled skill using the pinned Vercel skills installer. User scope is the default; `--project` installs in a Git repository. Agent selection is interactive, or explicit with repeated `--agent` flags and `--yes`. Use `--skip-skills` when only configuring organization knowledge. `--organization <source>` adds a declaration to the project's existing config (or creates `review.yaml`), and `--ref` selects its ref. Existing selections cannot be changed implicitly through setup; edit the config and run `sync --update`.

`review sync` creates an initial `.review/knowledge.lock.json`, or restores the exact revision already recorded there. `review sync --update` resolves the configured ref again and records a new revision after validating its manifest, documents, and policy compatibility. Failed updates leave the previous lock intact. Commit the configuration, repo documents, and lock; keep the cache outside the project. The lock is shared project state, not a personal organization preference.

The cache uses `$XDG_CACHE_HOME/review`, `~/.cache/review` on Unix, or the local app-data directory on Windows. `REVIEW_CACHE_DIR` overrides the cache location. Cache repositories are bare Git repositories identified by source. Review commands never fetch; a locked, cached revision supports offline review.

## During review

If a valid matching lock exists but its cache is missing, normal `review sync` can restore that exact revision without changing the lock. A missing/mismatched lock or policy conflict is an onboarding/configuration issue: report it instead of claiming successful validation. Do not run setup or `sync --update` during a read-only review, or advance organization knowledge to bypass an error.

Use the repo's selected organization revision and preserve required rules. Knowledge changes should be proposed and approved through Git; do not promote one review's observation into organization policy automatically.
