# Review skill

A T3 session reviews a local git diff by following [`.agents/skills/review/SKILL.md`](.agents/skills/review/SKILL.md). The session reads the change and reports defects in correctness and security.

Use this repository as the project, or copy `.agents/skills/review/` into the project you want reviewed.

Optional `review.yaml`, `review.yml`, or `review.json` in that project chooses which skills apply to which paths and sets the severity and confidence floor. The skill describes the file.
