# Shared Review Agent stamp service

The service and its clients are part of the existing Effect TypeScript CLI. The GitHub reviewer pool, token refresh and Azure Table persistence are adapted from [ForwardPathAI/fp-git-helper](https://github.com/ForwardPathAI/fp-git-helper); see [ORIGIN.md](ORIGIN.md). All onboarding and administration use CLI commands. GitHub hosts the authorization consent page; this project has no enrollment frontend, callback page or Python runtime.

## Organization setup

Build and install the review CLI with Node.js 22.20 or newer. Configure a GitHub App with **Pull requests: read and write** and **Contents: read**, install it on enabled repositories, and enable **Device Flow** and expiring user tokens. The service approves through opted-in user access tokens. GitHub documents the [device authorization flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

Provide these settings through the service's environment or secret manager:

| Setting | Purpose |
| --- | --- |
| `STAMP_PUBLIC_URL` | Full externally reachable HTTPS endpoint, e.g. `https://review.example.com/api/stamp` |
| `STAMP_REPOSITORIES` | Explicit comma-separated `OWNER/REPO` allowlist |
| `STAMP_KEY` | Approval key; at least 32 characters |
| `STAMP_ENROLL_KEY` | Separate enrollment key; at least 32 characters |
| `STAMP_ADMIN_KEY` | Separate administration key; at least 32 characters |
| `TABLE_STORAGE_CONNECTION` | Azure Table storage connection string |
| `GITHUB_APP_CLIENT_ID` | GitHub App client ID |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App client secret, used to refresh user tokens |

Generate three distinct random keys and distribute each only to its callers. Start the service behind a reverse proxy that provides HTTPS:

```sh
review stamp serve --host 127.0.0.1 --port 8080
```

From a checkout, run `npm ci`, `npm run build`, then `node dist/main.js stamp serve`. The Node listener uses HTTP; the public endpoint must use HTTPS. Forward `/api/*` to the listener. `GET /api/health` reports health without authentication. This can run on a MacBook or a shared Node host; a shared deployment must remain reachable by its CLI users.

The service creates its own `ReviewUsers`, `ReviewEnrollments` and `ReviewStamps` tables. Protect storage access because it holds user access and refresh tokens. It does not reuse the upstream project's enrollment tables; reviewers explicitly consent to this deployment.

## Reviewer enrollment

Administrators supply the trusted service URL and enrollment key through the reviewer's local configuration:

```sh
export REVIEW_STAMP_URL=https://review.example.com/api/stamp
# Configure REVIEW_STAMP_ENROLL_KEY through your normal secret configuration.
review stamp enroll
```

The CLI explains the automated approval consent and asks for confirmation. It then prints a code and `https://github.com/login/device`. The reviewer authorizes the GitHub App on GitHub; the CLI waits and reports the enrolled username. `review stamp enroll --yes` explicitly opts in without the local confirmation prompt. GitHub authorization is still required. Device codes, OAuth access tokens and refresh tokens stay in the service; the CLI receives only a temporary polling capability and identity data.

Administrators configure `REVIEW_STAMP_ADMIN_KEY` and use:

```sh
review stamp users
review stamp remove USERNAME
```

The list contains usernames and GitHub IDs only. Removal deletes the enrollment; a reviewer can also revoke the GitHub App's authorization on GitHub. An approval already in flight may finish after removal.

## Stamping behavior

Stamp callers configure `REVIEW_STAMP_URL` and `REVIEW_STAMP_KEY` (the service's `STAMP_KEY`). Each repository authorizes the same endpoint on its base branch:

```yaml
stamp:
  enabled: true
  service: https://review.example.com/api/stamp
  denyPaths: ["infra/**", ".github/workflows/**"]
  maxChangedLines: 400
```

After a clean whole-PR review:

```sh
review stamp approve /tmp/findings.json --repo /path/to/repository \
  --pr https://github.com/ORG/REPO/pull/123 \
  --base <reviewed-merge-base> --head <reviewed-head>
```

`--dry-run` validates and previews without contacting the service. The CLI sends keys in the `x-review-key` header, never in a report or URL. The locally trusted URL must match the base branch's endpoint before an approval key is sent.

The service enforces its repository allowlist, current open/non-draft PR, reviewed head and whole-PR merge base, base-branch authorization, protected paths, complete text patch coverage and line limit. Both sides of renames are checked. It trusts the agent's defect assessment and does not run a second AI review.

Reviewer selection is shuffled, excludes the author by GitHub user ID, and considers up to five candidate failures. The review body labels the action **Review Agent — automated approval** and names the reviewed commits. `commit_id` binds the review to the head. Repository permissions and branch rules decide whether the approval satisfies merge requirements. Enable stale-approval dismissal so later commits invalidate approvals.

Reservations are keyed by repository, PR and head. An active completed approval returns `already-approved`; a pending reservation blocks concurrent or uncertain duplicate writes. Only explicit GitHub rejections permit another reviewer. A dismissed approval requires reconciliation.

After an uncertain outcome, inspect GitHub and the `ReviewStamps` row. Do not delete a pending row while its request may still be executing. If the approval landed, reconcile the row's JSON `payload` to `{ "status": "approved", "result": { "action": "approved", "pr": "...", "head": "...", "approvedBy": "...", "reviewUrl": "..." } }`. If the invocation has ended and no approval landed, an administrator can delete the row to allow a new attempt. The CLI does not automatically retry unknown writes.

## Development

```sh
npm run typecheck
npm test
npm run build
```

Tests use fake GitHub clients, HTTP responses and in-memory storage; they make no live approvals. The runtime lives in `src/stamp*.ts`. This directory contains deployment documentation and upstream attribution only.
