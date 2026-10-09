# Review Agent approval service

The approval service is part of the Effect TypeScript review CLI (`src/stamp*.ts`). It submits PR approvals as one organization-owned GitHub App after a developer's local review agent has reviewed and published a clean whole-PR review. It is stateless: no database, user tokens, reviewer pool or frontend.

## GitHub App

Create a GitHub App owned by the organization, for example **Review Agent**:

- Repository permissions: **Pull requests: read and write**, **Contents: read**, and **Metadata: read**.
- Webhook: disabled. No callback URL, device flow or user authorization is needed.
- Installation: only this organization.

Generate a private key. Install the app on the repositories whose PRs it may approve. The installation is the repository allowlist. Each repository also opts in through `stamp.enabled` on its base branch.

Approvals appear as `<app-slug>[bot]`. Branch protection and rulesets decide whether that approval counts toward required reviews. Before relying on it, confirm on a scratch repository with required approvals. A GitHub App cannot be a code owner, so code-owner requirements still need a person. Enable dismissal of stale approvals so new commits require a new review and stamp.

## Deployment

Build and install the review CLI with Node.js 22.20 or newer. Provide these settings through the host's environment or secret manager:

| Setting | Purpose |
| --- | --- |
| `STAMP_PUBLIC_URL` | Full externally reachable HTTPS endpoint, e.g. `https://review.example.com/api/stamp` |
| `STAMP_KEY` | Shared approval key; at least 32 random characters |
| `GITHUB_APP_ID` | Numeric GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | The app's PEM private key; escaped `\n` newlines are accepted |

Start the service behind a reverse proxy that provides HTTPS:

```sh
review stamp serve --host 127.0.0.1 --port 8080
```

From a checkout, run `npm ci`, `npm run build`, then `node dist/main.js stamp serve`. The Node listener uses HTTP; the public endpoint must use HTTPS. Forward `/api/*` to the listener. `GET /api/health` reports health without authentication. The service needs outbound access to `api.github.com`.

Anyone holding the private key can approve PRs on every installed repository. Keep it in a secret manager and rotate it from the app settings if exposed.

## Developer setup

Distribute the endpoint and approval key through normal secret configuration:

```sh
export REVIEW_STAMP_URL=https://review.example.com/api/stamp
# Configure REVIEW_STAMP_KEY through your normal secret configuration.
```

Each repository authorizes the same endpoint in `.review/config.json` on its base branch:

```json
{
  "stamp": {
    "enabled": true,
    "service": "https://review.example.com/api/stamp",
    "denyPaths": ["infra/**", ".github/workflows/**"],
    "maxChangedLines": 400
  }
}
```

Any key holder can request a stamp, including for their own PR. Rotate `STAMP_KEY` when someone leaves.

## Stamping behavior

After a clean whole-PR review is published:

```sh
review stamp approve /tmp/findings.json --repo /path/to/repository \
  --pr https://github.com/ORG/REPO/pull/123 \
  --base <reviewed-merge-base> --head <reviewed-head> --confidence 4
```

For each request, the service checks the `x-review-key` header. It signs a short-lived app JWT and creates an installation token limited to that repository, with pull-request write and contents read permissions. It then requires:

- zero accepted findings and an overall confidence of at least 4/5;
- an open, non-draft PR whose current head and merge base match the review;
- exactly one review config on the base branch, with `stamp.enabled` and this service's URL;
- complete text patches, no protected paths (including both sides of renames), and changes within `stamp.maxChangedLines`;
- the linked review comment, on this PR, recording the same range, zero accepted findings and the same confidence.

The approval is an `APPROVE` review with `commit_id` set to the reviewed head. Its body names the reviewed commits, the dropped draft count, the confidence and the review comment.

GitHub's review list makes requests idempotent. An active bot approval at the reviewed head returns `already-approved`. A dismissed bot approval at that head is refused, so a person must approve. Concurrent duplicates can at most produce two approvals from the same bot, which count as one. After a timeout, rerun the same command; the service finds an approval that landed. GitHub's explicit refusals (HTTP 403/422) are returned with GitHub's message.

## Development

```sh
npm run typecheck
npm test
npm run build
```

Tests use generated keys, fake GitHub responses and a fake `fetch`; they make no live approvals.
