---
name: review
description: Review a local git diff for real defects in correctness and security. Use when the user asks to review a change, commit, branch, pull request, or worktree.
---

# Review

You are the reviewer. This session is already the agent, so do not launch another one. Do not edit the repository.

## Range

Default base is `HEAD~1` and head is `HEAD`. Use the base the user names. Include uncommitted changes when the user asks for the worktree.

## Gather

Diff that range. Read each changed code file. Read callers, callees, and tests when the diff is not enough to judge the change. Read `AGENTS.md`, `CLAUDE.md`, and `CODEOWNERS` when they exist. Skip binary files.

Read `review.yaml`, `review.yml`, or `review.json` when one exists. For each changed file, apply the skills its path rules allow. When no path rule matches, apply correctness and security.

```yaml
skills:
  - correctness
  - security
severity:
  minimum: medium
paths:
  - pattern: "api/**"
    skills:
      - security
rules:
  - Do not report style-only issues.
minimumConfidence: 0.7
```

`api/**` matches `api/v1/user.ts` and does not match `web/api/user.ts`. `*.ts` does not match `src/user.ts`. When several rules match, a skill applies only if the global `skills` list includes it and a matching rule lists it.

## Correctness

Broken control flow, incorrect assumptions, null or undefined cases, state inconsistencies, missing error handling, edge cases, and regressions caused by this diff.

## Security

Auth or authz mistakes, injection, secret exposure, unsafe deserialization, trust-boundary violations, and insecure defaults caused by this diff.

## Rules

Follow `rules` from the review config. When the file is missing:

- Do not report style-only issues.
- Only report a real defect or a meaningful risk.
- Prefer evidence from the repository over assumptions.

## Report

State the base and head. For each finding that survives the check, give severity, skill, file, line range, title, explanation, a quote from the repository, and confidence from 0 to 1. Say how many drafts you dropped. If none survive, say the review found nothing that cleared the bar.

## Check

Drop a draft when any of these are true:

- The file is outside the diff or is binary.
- The skill is not allowed for that path.
- There is no explanation, or no quote from the repository.
- The line range is reversed or past the end of the file.
- Severity is below the config minimum. Default is `medium`. Rank is low, medium, high, critical.
- Confidence is below `minimumConfidence`. Default is 0.7.
- The same file, start line, and title already appears with equal or higher confidence.

Omit anything you are guessing about. An empty result is a valid review.
