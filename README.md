# Review

A skill an agent can call to review a local git diff. Cursor, Codex, Claude, T3, or any other agent that can read a skill can use it. The agent reads the change and reports real defects in correctness and security.

## Use it

The skill is [`.agents/skills/review/SKILL.md`](.agents/skills/review/SKILL.md).

Copy that folder into the project you want reviewed, at `.agents/skills/review/`, or point the agent at the file. Then ask it to review a change, a commit, a branch, or a pull request.

The agent diffs the range, reads the changed code and the nearby callers and tests, and reports findings that quote the repository. It skips style, binary files, and guesses.

## Optional config

A `review.yaml`, `review.yml`, or `review.json` in that project chooses which checks apply to which paths and sets the severity and confidence floor. The skill describes the file.
