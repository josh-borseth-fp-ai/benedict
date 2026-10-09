# Benedict stamping

A stamp is a GitHub approval from the organization's Benedict GitHub App, requested together with publishing the review. Your local agent does the review; the Benedict service posts the comment and approval as the app and does not run a model.

Each developer configures the service base URL as `BENEDICT_SERVICE_URL` and its key as `BENEDICT_SERVICE_KEY`. The CLI sends the key only to that locally configured HTTPS URL; repository content never chooses the destination. Never put the key in review config, findings, review context or conversation output.

The base branch's `.benedict/config.json` opts the repository in to stamping:

```json
{
  "stamp": {
    "enabled": true,
    "denyPaths": ["infra/**", ".github/workflows/**"],
    "maxChangedLines": 400
  }
}
```

A PR qualifies only when the review has zero accepted findings and an overall confidence of 4/5 or 5/5. Pass the original findings file, the same committed whole-PR range and config, the context file and the score, and add `--stamp`:

```sh
benedict publish /tmp/findings.json --repo /path/to/repository \
  --pr https://github.com/ORG/REPO/pull/123 \
  --base <resolved-merge-base> --head <reviewed-head> \
  --context-file /tmp/review-context.md --confidence 4 --stamp
```

Do not stamp a review below 4/5; publish it without `--stamp`, report it and request human review.

The service posts or updates the review comment first, then checks the stamp. The result's `stamp` field is one of:

- `{ "action": "approved" | "already-approved", "url": ... }`: the app's approval at the reviewed head.
- `{ "action": "refused", "code": ..., "message": ... }`: the review is published but not approved. The CLI exits 1.

Refusal codes include `findings`, `low_confidence`, `draft`, `partial_review` (the review does not start at the PR merge base), `stamp_disabled`, `config_error`, `protected_path`, `size_limit`, `coverage` (binary or missing text patches), `stale_review`, `stamp_dismissed` and `write_rejected` (GitHub refused the approval, with GitHub's message). Report the reason and request human review.

Exit 2 means the review was not published: an input or configuration error, a refusal of the whole request (for example `publish_refused` with `stale_review` or `repository_disabled`), or a failed service call.

- `service_auth`: `BENEDICT_SERVICE_URL` or `BENEDICT_SERVICE_KEY` is missing or invalid, or the key was rejected.
- `service_error`: the outcome is uncertain. Rerunning the same command is safe: an unchanged comment is not rewritten, and the service returns `already-approved` when the bot already approved that commit. It does not approve again after a dismissal.

Do not bypass a refusal with another approval route.

The app's installation is the repository allowlist. Branch rules decide whether the approval satisfies merge requirements. Code-owner reviews and other remaining requirements are handled by people. Deployment is documented in the review project's `app-service/README.md`.
