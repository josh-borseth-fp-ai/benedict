# Review Agent stamping

A stamp is a GitHub approval from the organization's Review Agent GitHub App, submitted by the shared approval service after your review. Each developer configures the trusted endpoint as `REVIEW_STAMP_URL` and the approval key as `REVIEW_STAMP_KEY`. Never put the key in review config, findings, review context or conversation output. The base branch's endpoint must match the trusted local URL before the key is sent.

The base branch configures:

```yaml
stamp:
  enabled: true
  service: https://review.example.com/api/stamp
  denyPaths: ["infra/**", ".github/workflows/**"]
  maxChangedLines: 400
```

A PR qualifies only when the review has zero accepted findings and an overall confidence of 4/5 or 5/5. Publish the review first. Its context must state the score once as `**Confidence: N/5**`. Then pass the original findings file, the same committed whole-PR range and config, and the same score:

```sh
review stamp approve /tmp/findings.json --repo /path/to/repository \
  --pr https://github.com/ORG/REPO/pull/123 \
  --base <resolved-merge-base> --head <reviewed-head> --confidence 4 --dry-run
```

Omit `--dry-run` to submit the stamp. Do not stamp a review below 4/5; report it and request human review.

Success returns `action` (`approved` or `already-approved`), `pr`, `head`, `approvedBy` (the app's bot account) and `reviewUrl`. A preview returns `action: dry-run`, the authorized service URL and the request; it does not need a service key.

Exit 2 means a refusal, an input or configuration error, or a failed service call.

- `publish_required`: the CLI could not find exactly one review comment from your account for the current range, with zero accepted findings and one confidence score. Publish the current review, then retry.
- `stamp_refused` or another service code: report the reason and request human review.
- HTTP 401: the key is missing, wrong or rotated.
- Uncertain outcome: an approval may have landed. Rerunning the same command is safe, because the service returns `already-approved` when the bot already approved that commit. It does not approve again after a dismissal.

Do not bypass a refusal with another approval route.

The service needs the app installed on the repository, base-branch authorization, and a current, clean, published whole-PR review. Branch rules decide whether the approval satisfies merge requirements. Code-owner reviews and other remaining requirements are handled by people. Deployment is documented in the review project's `stamp-service/README.md`.
