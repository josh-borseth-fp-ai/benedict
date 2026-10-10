# Benedict approval

Benedict can approve a PR as the organization's Benedict GitHub App, requested together with publishing the review. Your local agent does the review; the CLI posts the review and approval as the app.

The CLI reads the app ID and private key from the Benedict Infisical project with the developer's `infisical login`. Never fetch, print or copy those credentials, and never put them in review config, findings, review context or conversation output.

The base branch's `.benedict/config.json` opts the repository in to approval:

```json
{
  "approve": {
    "enabled": true,
    "denyPaths": ["infra/**", ".github/workflows/**"],
    "maxChangedLines": 400
  }
}
```

A PR qualifies only when the review has zero accepted findings and an overall confidence of 4/5 or 5/5. Pass the original findings file, the same committed whole-PR range and config, the context file and the score, and add `--approve`:

```sh
benedict publish /tmp/findings.json --repo /path/to/repository \
  --pr https://github.com/ORG/REPO/pull/123 \
  --base <resolved-merge-base> --head <reviewed-head> \
  --context-file /tmp/review-context.md --confidence 4 --approve
```

Do not request approval for a review below 4/5; publish it without `--approve`, report it and request human review.

The CLI checks the approval conditions before it posts. When they pass, the review itself is submitted as the approval. Otherwise the review is posted as a comment review. The result's `approval` field is one of:

- `{ "action": "approved" | "already-approved", "url": ... }`: the app's approval at the reviewed head.
- `{ "action": "refused", "code": ..., "message": ... }`: the review is published but not approved. The CLI exits 1.

Refusal codes include `findings`, `low_confidence`, `draft`, `partial_review` (the review does not start at the PR merge base), `approve_disabled`, `config_error`, `protected_path`, `size_limit`, `coverage` (binary or missing text patches), `approval_dismissed` and `write_rejected` (GitHub refused the approval, with GitHub's message). Report the reason and request human review.

Exit 2 means the review was not published: an input or configuration error, a refusal of the whole publication (for example `stale_review` or `repository_disabled`), or a failed GitHub call.

- `app_credentials`: the Infisical CLI is missing or signed out, or the Benedict project lacks the app secrets. Ask the user to run `infisical login`.
- `write_uncertain`: the outcome is uncertain. Rerunning the same command is safe: an identical review is not posted again, and `already-approved` is returned when the bot already approved that commit. It does not approve again after a dismissal.

Do not bypass a refusal with another approval route.

The app's installation is the repository allowlist. Branch rules decide whether the approval satisfies merge requirements. Code-owner reviews and other remaining requirements are handled by people. App setup is documented in the Benedict README.
