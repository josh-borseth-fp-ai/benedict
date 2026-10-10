# Benedict

Benedict is a code review skill for coding agents, plus a CLI that keeps the agent honest. Your agent does the review locally. The CLI throws out any finding it can't back up with a quote from the source. The Benedict GitHub App then posts the review and can approve PRs that come back clean.

Benedict is a cat who reviews code.

## Install

Requires Node.js 22.20+ and Git.

```sh
npm install --global https://github.com/josh-borseth-fp-ai/benedict/releases/latest/download/benedict.tgz
benedict setup
```

`benedict setup` installs the skill for your coding agents. Rerun both commands to upgrade. pnpm and Bun work too: `pnpm add --global <url>` or `bun add --global <url>`.

## Use it

Ask your agent to review a change with the `benedict` skill, for example "use benedict to review this PR". The skill lives at [`.agents/skills/benedict/SKILL.md`](.agents/skills/benedict/SKILL.md).

The agent then:

1. Runs `benedict context` to get the diff and the review policy.
2. Reads the code and writes draft findings as JSON.
3. Runs `benedict check`, which drops findings that are outside the diff, don't quote the source, fall below the thresholds, or are duplicates.
4. For a PR, runs `benedict publish` to post the review.

Every review includes an overall **Confidence: N/5**. PR reviews also include a Mermaid diagram of what changed, and PRs that change the UI get screenshots and a short video.

## Commands

```sh
benedict context                         # review HEAD~1..HEAD
benedict context --base main --head HEAD # a different range
benedict context --worktree              # uncommitted changes
benedict context --pr <PR URL>           # a GitHub PR

benedict check findings.json             # validate draft findings
benedict publish findings.json --pr <PR URL> --confidence 4 [--approve] [--dry-run]

benedict setup                           # install the skill
benedict sync                            # fetch organization knowledge
```

Run `benedict <command> --help` for flags. The finding format is in [`references/cli.md`](.agents/skills/benedict/references/cli.md).

`check` exits 0 when every finding passes, 1 when some were rejected, and 2 on an error.

## Publishing to GitHub

Sign in to the [GitHub CLI](https://cli.github.com/) with `gh auth login` and to the [Infisical CLI](https://infisical.com/docs/cli/overview) with `infisical login`. There is nothing else to set: when `publish` posts, it reads the GitHub App's credentials from ForwardPath's Benedict Infisical project, whose ID is built into the CLI.

`publish` posts one GitHub review from `benedict[bot]`, with an inline comment for each finding. Use `--dry-run` to preview the review without posting it; it doesn't need Infisical. Rerunning the same command is safe.

## Approving PRs

With `--approve`, the bot approves the PR if the review has no findings and a confidence of 4/5 or higher. The repository opts in on its base branch:

```json
{
  "approve": {
    "enabled": true,
    "denyPaths": ["infra/**", ".github/workflows/**"],
    "maxChangedLines": 400
  }
}
```

Benedict also refuses draft PRs, partial reviews, binary changes, and changes to `.benedict/**` or the skill. When it refuses, it still posts the review as a comment and `publish` exits 1.

To require a review on every PR, add this to a repository's `AGENTS.md`:

```md
## Benedict

After opening a PR or pushing to one, use the `benedict` skill to review the whole
current PR, publish the review, and request approval. Fix accepted findings and
repeat. If approval is refused, report the reason and request human review; do
not approve the PR another way.
```

Anyone with access to the Benedict Infisical project holds the app's private key, so they can approve PRs, including their own, and could skip these checks by calling GitHub directly. Remove people from the project when they leave, rotate the key if it may have been copied, and enable dismissal of stale approvals on protected branches.

## Setting up the GitHub App

Create an organization-owned GitHub App:

- Permissions: **Pull requests: read and write**, **Contents: read**, **Metadata: read**.
- Webhook: off.
- Installation: this organization only.

Install it on the repositories it should review. Generate a private key, then add two secrets to the Benedict Infisical project's `prod` environment:

| Secret | Value |
| --- | --- |
| `BENEDICT_APP_ID` | The numeric app ID |
| `BENEDICT_APP_PRIVATE_KEY` | The full PEM private key |

Branch rules decide whether the bot's approval counts; confirm on a scratch repository before relying on it. A GitHub App can't be a code owner, so code-owner reviews still need a person.

## Configuration

Add an optional `.benedict/config.json` to the reviewed repository:

```json
{
  "$schema": "https://raw.githubusercontent.com/josh-borseth-fp-ai/benedict/main/schemas/config.schema.json",
  "skills": ["correctness", "security"],
  "minimumSeverity": "medium",
  "minimumConfidence": 0.7,
  "paths": [{ "pattern": "api/**", "skills": ["security"] }],
  "rules": ["Do not report style-only issues."]
}
```

The values shown are the defaults, apart from `paths` and `rules`.

## Organization knowledge

Teams can share review rules and Markdown docs from a separate Git repository that contains a `.benedict/organization.json` manifest. Connect a project with:

```sh
benedict setup --organization https://github.com/your-org/engineering-knowledge.git
```

This pins a revision in `.benedict/knowledge.lock.json`. Commit that file. `benedict sync` restores the pinned revision on a new machine, and `benedict sync --update` moves it forward. See [`references/knowledge.md`](.agents/skills/benedict/references/knowledge.md) for details.

## Develop

```sh
npm ci
npm run typecheck
npm test
npm run build
```

After changing the config schemas in `src/model.ts`, run `npm run schemas`. Every merge to `main` releases the next patch version.
