# Agent notes

This is an Effect 4 application. Prefer Effect modules over raw Node APIs.

- Services are `Context.Service` classes with a `layer`.
- Effects that cross a boundary use `Schema`.
- CLI input is `effect/cli`.
- Processes are `effect/process`. Do not spawn provider CLIs any other way.
- Files, paths, config, YAML, streams, cache, and the symbol graph use Effect's own modules.

The agent backend is replaceable. `codexLayer` and `claudeLayer` launch the official local CLIs. Do not read `~/.codex`, `~/.claude`, session cookies, or API tokens, and do not add flags that proxy a subscription.

v0 is the local `review` command in `PLAN.md`. Do not start T3 or GitHub integration until that command is solid.
