# Benedict service

The Benedict service posts reviews and approvals to GitHub as your organization's Benedict GitHub App. It's part of the CLI (`benedict serve`). It never runs a model and keeps no state.

## Create the GitHub App

Create an organization-owned GitHub App with these settings:

- Permissions: **Pull requests: read and write**, **Contents: read**, **Metadata: read**.
- Webhook: off.
- Installation: this organization only.

Generate a private key, then install the app on the repositories it should review.

## Deploy

Install the CLI (see the [main README](../README.md#install)) and set these:

| Setting | Purpose |
| --- | --- |
| `BENEDICT_SERVICE_KEY` | Shared key, at least 32 random characters |
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | The app's PEM private key |

Run it behind an HTTPS reverse proxy that forwards `/api/*`:

```sh
benedict serve --host 127.0.0.1 --port 8080
```

`POST /api/reviews` requires the key. `GET /api/health` doesn't. The service needs outbound access to `api.github.com`.

Give developers `BENEDICT_SERVICE_URL` and `BENEDICT_SERVICE_KEY` through your usual secret tooling.

## What it checks

Before posting, the service confirms that the PR is open, the reviewed head is the current head, and the reviewed range belongs to the PR. Approvals also have to pass the rules in the [main README](../README.md#approving-prs). Repeated requests don't create duplicate reviews.

Branch rules decide whether the bot's approval counts. A GitHub App can't be a code owner, so code-owner reviews still need a person.
