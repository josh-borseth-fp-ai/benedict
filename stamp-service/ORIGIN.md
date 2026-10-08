# Source

The shared GitHub reviewer pool, token refresh, Azure Table storage and candidate retry behavior are adapted from [ForwardPathAI/fp-git-helper](https://github.com/ForwardPathAI/fp-git-helper), revision `9c8f1cf1bbda6f3a3518ec8166886ead65ac9511`. The implementation is rewritten in Effect TypeScript in `src/stamp*.ts`; upstream Python and frontend code are not shipped.

The source repository has no license file. This is an internal adaptation requested by its user, not a relicensing of the upstream code.

This service replaces the Teams polling trigger with an authenticated HTTP stamp request and browser onboarding with CLI-driven GitHub device authorization. It uses the review CLI's existing AI review, checks the reviewed commit and base-branch stamp policy, and records the approval with AI attribution.
