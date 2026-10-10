# Benedict approval

Every published PR review carries the reviewer's decision on whether to approve. Your local agent does the review and makes the decision; the CLI posts the review and the approval as the organization's Benedict GitHub App.

The CLI reads the app ID and private key from the Benedict Infisical project with the developer's `infisical login`. Never fetch, print or copy those credentials, and never put them in findings, review context or conversation output.

## Deciding

Decide whether the PR is safe to approve as a separate judgment after the review. Accepted findings and the overall confidence score inform it but do not decide it. Pass `--decision approve` or `--decision comment` along with the original findings file, the same committed whole-PR range, the context file and the score:

```sh
benedict publish /tmp/findings.json --repo /path/to/repository \
  --pr https://github.com/ORG/REPO/pull/123 \
  --base <resolved-merge-base> --head <reviewed-head> \
  --context-file /tmp/review-context.md --confidence 4 --decision approve
```

With `--decision approve`, the review itself is submitted as the approval, and its inline comments carry any accepted findings. With `--decision comment`, it is posted as a comment review.

## What the CLI checks

The CLI has no approval rules of its own. It only makes sure an approval covers what was reviewed:

- The PR is open and its head is the reviewed commit. Otherwise nothing is posted.
- The review starts at the PR's merge base. A narrower review is published but not approved.
- A Benedict approval of the same commit that a person dismissed is not renewed.

## Outputs

The result's `approval` field is `null` for `--decision comment`. For `--decision approve` it is one of:

- `{ "action": "approved" | "already-approved", "url": ... }`: the app's approval at the reviewed head.
- `{ "action": "refused", "code": ..., "message": ... }`: the review is published but not approved. The CLI exits 1.

Refusal codes are `partial_review` (the review does not start at the PR merge base), `approval_dismissed`, and `write_rejected` (GitHub refused the approval, with GitHub's message). Report the reason and request human review.

Exit 2 means the review was not published: an input error, a refusal of the whole publication (for example `stale_review` or `repository_disabled`), or a failed GitHub call.

- `app_credentials`: the Infisical CLI is missing or signed out, or the Benedict project lacks the app secrets. Ask the user to run `infisical login`.
- `write_uncertain`: the outcome is uncertain. Rerunning the same command is safe: an identical review is not posted again, and `already-approved` is returned when the bot already approved that commit. It does not approve again after a dismissal.

Do not bypass a refusal with another approval route.

The app's installation is the repository allowlist. Branch rules decide whether the approval satisfies merge requirements. Code-owner reviews and other remaining requirements are handled by people. App setup is documented in the Benedict README.
