# Benedict service

The Benedict service is part of the Benedict CLI (`src/app-*.ts`). It posts reviews and approvals to GitHub as one organization-owned GitHub App. A developer's local coding agent does the review and all AI inference; the service never runs a model. It is stateless: no database, user tokens, reviewer pool or frontend.

## GitHub App

Create a GitHub App owned by the organization, for example **Benedict**:

- Repository permissions: **Pull requests: read and write**, **Contents: read**, and **Metadata: read**.
- Webhook: disabled. No callback URL, device flow or user authorization is needed.
- Installation: only this organization.

Generate a private key. Install the app on the repositories it may post reviews to. The installation is the repository allowlist. Each repository also opts in to approval through `approve.enabled` on its base branch.

Reviews, inline comments and approvals appear as `<app-slug>[bot]`. Branch protection and rulesets decide whether that approval counts toward required reviews. Before relying on it, confirm on a scratch repository with required approvals. A GitHub App cannot be a code owner, so code-owner requirements still need a person. Enable dismissal of stale approvals so new commits require a new review and approval.

## Deployment

Install the Benedict CLI with Node.js 22.20 or newer, using the release install command in the [main README](../README.md#install). Provide these settings through the host's environment or secret manager:

| Setting | Purpose |
| --- | --- |
| `BENEDICT_SERVICE_KEY` | Shared service key; at least 32 random characters |
| `GITHUB_APP_ID` | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | The app's PEM private key; escaped `\n` newlines are accepted |

Start the service behind a reverse proxy that provides HTTPS:

```sh
benedict serve --host 127.0.0.1 --port 8080
```

From a checkout, run `npm ci`, `npm run build`, then `node dist/main.js serve`. The Node listener uses HTTP; the public endpoint must use HTTPS. Forward `/api/*` to the listener. `POST /api/reviews` takes reviews. `GET /api/health` reports health without authentication. The service needs outbound access to `api.github.com`.

Anyone holding the private key can post and approve PRs on every installed repository. Keep it in a secret manager and rotate it from the app settings if exposed.

## Developer setup

Distribute the service base URL and key through normal secret configuration:

```sh
export BENEDICT_SERVICE_URL=https://benedict.example.com
# Configure BENEDICT_SERVICE_KEY through your normal secret configuration.
```

The CLI sends the key only to this locally configured HTTPS URL. Repositories need no service setting; to allow approval, a repository enables it in `.benedict/config.json` on its base branch:

```json
{
  "approve": {
    "enabled": true,
    "denyPaths": ["infra/**", ".github/workflows/**"],
    "maxChangedLines": 400
  }
}
```

Any key holder can publish reviews and request approvals, including for their own PR. Rotate `BENEDICT_SERVICE_KEY` when someone leaves.

## Request handling

After local validation, `benedict publish` sends a version-1 review: the PR, the reviewed base and head, the accepted findings, the dropped draft count, the overall confidence, the Markdown context, the organization knowledge revision, and whether to approve.

For each request, the service checks the `x-benedict-key` header. It signs a short-lived app JWT and creates an installation token limited to that repository, with pull-request write and contents read permissions. Then it requires:

- an open PR whose current head is the reviewed head;
- a reviewed base that is the PR merge base or a later ancestor of the head.

It reads the PR's file patches and renders the review with the same renderer as the CLI. Each finding becomes an inline comment anchored to the head-side lines it shares with a diff hunk; findings outside the diff are listed in the summary body. The summary starts with a marker holding a digest of the review content.

The service submits everything as one GitHub PR review with `commit_id` set to the reviewed head, so the summary and inline comments land together. Each publication with new content creates a new review. If the app already posted a review with the same digest at that head, the service makes no write and returns `unchanged`. PR metadata is rechecked before writing.

When the request asks to approve, the service first requires:

- zero accepted findings and an overall confidence of at least 4/5;
- a non-draft PR, reviewed from its merge base;
- exactly one review config on the base branch, with `approve.enabled`;
- complete text patches, no protected paths (including both sides of renames), and changes within `approve.maxChangedLines`.

When they pass, the review is submitted with the `APPROVE` event and an approval note in its body. A failed condition is returned as a `refused` approval outcome, and the review is submitted with the `COMMENT` event instead of failing the request. If GitHub refuses the approval (HTTP 403/422), the service posts the comment review and returns the refusal with GitHub's message.

GitHub's review list makes requests idempotent. An active bot approval at the reviewed head returns `already-approved`. A dismissed bot approval at that head is refused, so a person must approve. Concurrent duplicates can at most produce two identical reviews or two approvals from the same bot, which count as one. After a timeout, rerun the same command; the service finds the review that landed.

The bot approval stays in place if a later review at the same head reports findings. With stale-approval dismissal enabled, pushing a fix dismisses it; otherwise dismiss it by hand.

## Development

```sh
npm run typecheck
npm test
npm run build
```

Tests use generated keys, fake GitHub responses and a fake `fetch`; they make no live comments or approvals.
