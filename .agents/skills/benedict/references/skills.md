# Review skills

A review skill tells the reviewer what to look for. Every review uses three scopes:

- **Built-in:** `correctness` and `security`, shipped with the CLI.
- **Organization:** skills from a shared Git repository, pinned to a locked revision.
- **Repository:** skills committed in the reviewed repository.

When two scopes have a skill with the same name, the more specific one wins: a repository skill replaces an organization or built-in skill, and an organization skill replaces a built-in one. `benedict context` reports the scope of the skill that applies.

## Writing a skill

A skill is a directory under `.benedict/skills/` containing a `SKILL.md`, in the same format as agent skills:

```md
---
name: payments
description: Money handling, idempotency and currency rounding.
paths:
  - "billing/**"
  - "api/payments/**"
---

# Payments

Report double charges, lost refunds and rounding that changes totals...
```

- `name`: lowercase letters, digits and hyphens. It must match the directory name.
- `description`: required. Context shows it to the reviewer before the skill is opened, so say what the skill covers.
- `paths`: optional repository-relative globs, as a YAML list or a JSON-style array of quoted strings. Without `paths`, the skill applies to every file. `api/**` matches `api/v1/user.ts` but not `web/api/user.ts`, and `*.ts` does not match `src/user.ts`.

Other frontmatter keys are ignored. The Markdown body is the instruction the reviewer follows. Only `SKILL.md` is read; other files in the directory are not. Each `SKILL.md` must be a regular text file of at most 256 KiB, not a link.

## Skills come from the review's base

Benedict reads `.benedict/config.json`, `.benedict/organization.lock.json` and `.benedict/skills/` from the review's base commit, not from the change under review. A PR that adds or edits a skill is reviewed under the previous skills, and the new skills apply once it merges. A worktree review uses the skills committed at `HEAD`.

`benedict context` lists each skill's name, description, scope and `paths`, and gives each changed file the names of the skills that apply to it. `benedict skill <name> --base <range.base>` prints a skill's body.

## Organization skills

An organization repository keeps its shared skills in `.benedict/skills/`. When reviewing the organization repository itself, those same skills are its repository skills.

Connect a project with `benedict setup --organization <source>`, optionally with `--ref` (default `HEAD`). This writes the only setting Benedict has:

```json
{ "organization": { "source": "https://github.com/your-org/engineering-skills.git", "ref": "main" } }
```

Sources support HTTPS, SSH, file URLs, and local repository paths. Git owns authentication; embedded URL passwords and HTTPS usernames are rejected. Refs must select one branch, tag, or commit, not a wildcard or refspec.

`benedict sync` creates `.benedict/organization.lock.json`, or restores the exact revision already recorded there. `benedict sync --update` resolves the configured ref again and records a new revision after validating its skills. Failed updates leave the previous lock intact. Commit the config and the lock. To change the source or ref of an existing organization, edit the config and run `sync --update`.

The cache uses `$XDG_CACHE_HOME/benedict`, `~/.cache/benedict` on Unix, or the local app-data directory on Windows. `BENEDICT_CACHE_DIR` overrides the cache location, which must be outside the reviewed repository. Cache repositories are bare Git repositories identified by source. Organization skills are read from Git objects at the locked revision; organization code is never checked out or executed. Review commands never fetch, so a cached revision supports offline review.

## During review

If the base has a valid lock but the cache is missing, `benedict sync` restores that exact revision without changing the lock. A missing or mismatched lock, or an invalid skill, is an onboarding issue: report it instead of claiming a validated review. Do not run setup or `sync --update` during a read-only review, or advance the organization revision to get past an error.

Skill changes are proposed and approved through Git; do not promote one review's observation into a skill automatically.
