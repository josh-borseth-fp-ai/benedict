# Review skills

A review skill tells the reviewer what to look for. Every review uses three scopes:

- **Built-in:** `correctness` and `security`, shipped with the CLI.
- **Organization:** skills from a shared Git repository, fetched from its default branch at every review.
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

## Where skills come from

Benedict reads `.benedict/config.json` and `.benedict/skills/` from the review's base commit, not from the change under review. A PR that adds or edits a repository skill is reviewed under the previous skills, and the new skills apply once it merges. A worktree review uses the skills committed at `HEAD`. Organization skills are always the latest on the organization repository's default branch.

`benedict context` lists each skill's name, description, scope and `paths`, and gives each changed file the names of the skills that apply to it. `benedict skill <name> --base <range.base>` prints a skill's body.

## Organization skills

An organization repository keeps its shared skills in `.benedict/skills/`. When reviewing the organization repository itself, those same skills are its repository skills.

Connect a project with `benedict setup --organization <source>`. Setup fetches the organization once to check that it has skills, then writes the only setting Benedict has:

```json
{ "organization": { "source": "https://github.com/your-org/engineering-skills.git" } }
```

Commit it. To change the source, edit the config. Sources support HTTPS, SSH, file URLs, and local repository paths. Git owns authentication; embedded URL passwords and HTTPS usernames are rejected.

There is no pin. `benedict context`, `skill` and `check` each fetch the organization's default branch and use its latest commit, and reviews report that revision. Organization skill changes reach every connected repository's next review. Protect the organization repository's default branch accordingly.

The cache uses `$XDG_CACHE_HOME/benedict`, `~/.cache/benedict` on Unix, or the local app-data directory on Windows. `BENEDICT_CACHE_DIR` overrides the cache location, which must be outside the reviewed repository. Cache repositories are bare Git repositories identified by source; they only save transfer and are never used in place of a fetch. Organization skills are read from Git objects at the fetched revision; organization code is never checked out or executed.

## During review

If the organization cannot be fetched (`organization_unavailable`), or its skills are missing or invalid, report it instead of claiming a validated review. Do not run setup or edit the config during a read-only review to get past an error.

Skill changes are proposed and approved through Git; do not promote one review's observation into a skill automatically.
