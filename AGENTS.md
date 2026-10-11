# Agent notes

This repository contains Benedict: the review skill at `.agents/skills/benedict/SKILL.md` and its Effect TypeScript CLI. Follow that skill when asked to review a change.

Do not launch another agent. Do not read provider credentials. Do not edit the repository under review.

## Developing this repository

The project is pre-production with no users. Do not add backwards compatibility, migrations, or legacy fallbacks; replace old behavior outright.

Persisted review state lives under `.benedict/`:

- `.benedict/config.json`: the optional organization source, and nothing else (`ConfigFile`).
- `.benedict/skills/<name>/SKILL.md`: review skills, in the standard skill format. The organization repository uses the same layout. Built-in skills live in `review-skills/`.

State files are JSON, never YAML; skill frontmatter is the only YAML. Path constants and schemas live in `src/model.ts`; import them rather than repeating paths. Reviews read config and repository skills from the base commit, never from the change under review. Organization skills are never pinned: every review fetches the organization's default branch. Approval is the reviewer's `--decision`; the CLI adds no approval policy. Severity and confidence are reported, never used as cutoffs. After changing the config schema, run `npm run schemas` to regenerate `schemas/config.schema.json`.
