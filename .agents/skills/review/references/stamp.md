# Direct GitHub stamping

The organization runs the shared Effect stamp service once with `review stamp serve`. Reviewers opt in with `review stamp enroll` and authorize GitHub's device code. Each developer configures the trusted endpoint as `REVIEW_STAMP_URL` and the approval key as `REVIEW_STAMP_KEY`; never put the key in review config, findings or conversation output. The base branch's endpoint must match the trusted local URL before the key can be sent.

The base branch's `.review/config.json` configures:

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

Use the original findings file and the same committed whole-PR range and config:

```sh
review stamp approve /tmp/findings.json --repo /path/to/repository \
  --pr https://github.com/ORG/REPO/pull/123 \
  --base <resolved-merge-base> --head <reviewed-head> --dry-run
```

Omit `--dry-run` when the user has asked for the stamp. Local-only review authorization does not authorize an approval.

Success returns `action` (`approved` or `already-approved`), `pr`, `head`, `approvedBy` and `reviewUrl`. A preview returns `action: dry-run`, the authorized service URL and the request; it does not need a service key or enroll a reviewer.

Exit 2 means a refusal, input/configuration error, or failed service call. Report the error without retrying automatically. A timeout may follow a successful GitHub write. Inspect the PR's reviews at the returned/reviewed head; the service retains a pending reservation for an administrator to reconcile. A dismissed approval is not silently reapproved.

The service needs an eligible reviewer other than the PR author, access to the repository, and a repository entry in its administrator-managed allowlist. HTTP 401 means the key is missing, wrong or not authorized for that operation. HTTP 409 is a refused stamp. After any failed approval request, inspect GitHub before retrying because a write may have succeeded. Do not bypass a refusal with another approval route.

Service deployment and CLI enrollment are documented in the review project's `stamp-service/README.md`. Enrollment uses `REVIEW_STAMP_ENROLL_KEY`; `review stamp users` and `review stamp remove USERNAME` use `REVIEW_STAMP_ADMIN_KEY`. These keys are separate from the approval key. Do not enroll an account or administer the pool as part of a PR review unless the user requests it.
