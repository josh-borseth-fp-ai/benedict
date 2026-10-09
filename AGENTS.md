# Agent notes

This repository contains the review skill at `.agents/skills/review/SKILL.md` and its Effect TypeScript CLI. Follow that skill when asked to review a change.

Do not launch another agent. Do not read provider credentials. Do not edit the repository under review.

## Developing this repository

The project is pre-production with no users. Do not add backwards compatibility, migrations, or legacy fallbacks; replace old behavior outright.

Persisted review state is JSON under `.review/`, never YAML:

- `.review/config.json`: repository policy, knowledge, organization source, and stamp settings (`ConfigFile`).
- `.review/organization.json`: organization manifest with `defaults`, `required`, and `knowledge` (`OrganizationManifest`).
- `.review/knowledge.lock.json`: the pinned organization revision written by `review sync`.

Path constants and schemas live in `src/model.ts`; import them rather than repeating paths. Repository policy, organization `defaults`, and `required` share field names (`skills`, `minimumSeverity`, `minimumConfidence`, `paths`, `rules`). The stamp workflow protects `.review/**`. After changing a config schema, run `npm run schemas` to regenerate `schemas/*.schema.json`.
