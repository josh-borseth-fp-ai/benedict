# Review

A skill an agent can call to review a local git diff. Cursor, Codex, Claude, T3, or any other agent that can read a skill can use it. The agent reads the change and reports real defects in correctness and security.

## Use it

The skill is [`.agents/skills/review/SKILL.md`](.agents/skills/review/SKILL.md).

Copy that folder into the project you want reviewed, at `.agents/skills/review/`, or point the agent at the file. Then ask it to review a change, a commit, a branch, or a pull request.

The agent diffs the range, reads the changed code and the nearby callers and tests, and reports findings that quote the repository. It skips style, binary files, and guesses.

## Optional config

A `review.yaml`, `review.yml`, or `review.json` in that project chooses which checks apply to which paths and sets the severity and confidence floor. The skill describes the file.

## Stamp a PR

When asked to review and stamp a GitHub PR, the agent reviews the whole PR. If nothing clears the bar, it posts `stamp <PR link>` to the team's Teams stamp channel, and the stamp bot approves the PR. The message and a PR comment say the request came from the review agent, not a manual stamp. Both are posted as you: Teams through your Teams MCP sign-in, GitHub through your `gh` sign-in.

`scripts/stamp.ts` decides whether a stamp is allowed, so the model does not. It refuses when any of these are true:

- Stamping is off in the base branch's review config, or no Teams channel is set.
- The PR is closed or a draft.
- The review did not cover the PR's current head, from its merge base.
- The review reported a finding.
- The PR changes the review config, the review skill, or a `denyPaths` glob.
- The PR changes more lines than `maxChangedLines`.
- The review agent already stamped this head commit.

It reads the config from the base branch, so a PR cannot loosen its own rules.

### Setup

1. Install the script's one dependency, [`yaml`](https://github.com/eemeli/yaml). It needs Node 22.18 or later.

   ```sh
   npm install --prefix .agents/skills/review
   ```

2. Sign in to GitHub with `gh auth login`.
3. Add [`@floriscornel/teams-mcp`](https://github.com/floriscornel/teams-mcp) to your agent and sign in with your Microsoft account:

   ```json
   {
     "mcpServers": {
       "teams-mcp": { "command": "npx", "args": ["-y", "@floriscornel/teams-mcp@latest"] }
     }
   }
   ```

   ```sh
   npx @floriscornel/teams-mcp@latest authenticate
   ```

   Sending channel messages needs the `ChannelMessage.Send` permission. If sign-in shows "Need admin approval", a Microsoft 365 admin has to grant consent once. The Teams MCP README explains how.

4. Turn stamping on in the project's review config, on its default branch:

   ```yaml
   stamp:
     enabled: true
     team: Engineering        # Teams team name
     channel: stamp           # stamp channel name
     denyPaths:               # never stamp PRs that touch these
       - "infra/**"
       - ".github/workflows/**"
     maxChangedLines: 400     # default 400
   ```

5. In GitHub branch rules, turn on "Dismiss stale pull request approvals". Otherwise commits pushed after a stamp keep the approval.

Then ask the agent to "review and stamp" a PR link.

### Limits

- The rules check the review's scope, not the model's judgment. A PR that manipulates the agent into reporting nothing could still be stamped. `denyPaths` and `maxChangedLines` limit how much that can matter.
- The Teams post is a tool call the agent makes after the script says yes. The skill tells it never to post any other way, but nothing outside the agent enforces that.
- The approval comes from whichever person the stamp bot picks. The 🤖 text in Teams and the PR comment are what show it was automated.
