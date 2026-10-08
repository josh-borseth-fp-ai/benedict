# Plan

`.agents/skills/review/SKILL.md` is the review. Whatever agent is already running calls the skill.

## Trust boundary

The current agent reads the diff and reports findings. Do not launch a second agent. Do not read provider credentials.

## Pipeline

```
The agent follows the review skill
  → diff, related code, applicable skills
  → drop drafts that miss the bar
  → report
  → when asked to stamp a PR: stamp.ts check → Teams MCP posts `stamp <url>` → stamp.ts comment
```

A reported finding has a file in the diff, a line range inside that file, a severity, a skill, a title, an explanation, a quote, and a confidence. The skill drops drafts that are style-only, outside the diff, on a binary file, for a skill the path does not allow, missing a quote or explanation, below the severity or confidence floor, or duplicates.

## Skills

v0 is one skill with two lenses: correctness and security. Path rules in `review.yaml` decide which lens applies. Later lenses stay conditional: database checks for migrations, API checks for public schemas, concurrency checks for shared state.

## Stamp

The stamp bot in Teams approves a PR when someone posts `stamp <url>` in its channel. The review agent can post that for a clean PR.

- `scripts/stamp.ts` decides, not the model. It checks the PR is open and current, the review covered the whole PR, there are no findings, no protected path changed, and the PR is under the line limit. It reads those rules from the base branch.
- Posting goes out as the developer. Teams uses [`@floriscornel/teams-mcp`](https://github.com/floriscornel/teams-mcp), which runs locally and signs in with the developer's Microsoft account. GitHub uses `gh`. There is no separate bot or service account.
- The Teams message and a PR comment carry the 🤖 Review Agent attribution. A hidden marker in the comment stops a second stamp for the same head commit.
- `yaml` is the script's only npm dependency, for reading `review.yaml`.

## Out of scope

A review command, hosted SaaS, choosing or proxying a model, credential handling, autonomous edits, approving a PR directly, a separate bot identity, and a vector database.
