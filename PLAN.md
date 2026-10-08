# Plan

T3 Code starts the agent. `.agents/skills/review/SKILL.md` is the review.

## Trust boundary

Do not launch a second coding agent. Do not read provider credentials. The session T3 already opened reads the diff and reports findings.

## Pipeline

```
T3 session follows the review skill
  → diff, related code, applicable skills
  → drop drafts that miss the bar
  → report
```

A reported finding has a file in the diff, a line range inside that file, a severity, a skill, a title, an explanation, a quote, and a confidence. The skill drops drafts that are style-only, outside the diff, on a binary file, for a skill the path does not allow, missing a quote or explanation, below the severity or confidence floor, or duplicates.

## Skills

v0 is one skill with two lenses: correctness and security. Path rules in `review.yaml` decide which lens applies. Later lenses stay conditional: database checks for migrations, API checks for public schemas, concurrency checks for shared state.

## Out of scope

A review command, hosted SaaS, choosing or proxying a model, credential handling, autonomous edits, and a vector database.
