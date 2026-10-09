# UI screenshots and focused video

Use this workflow for PRs that change visible UI or user interactions. Decide from the PR's purpose and reviewed diff which screens, states, and behavior matter; do not record a tour of the whole app. Include screenshots of the important changed states and a short video, preferably showing the feature working. Documentation, backend, and invisible refactors need no media unless they affect visible behavior.

## Check existing evidence and hand off

Read the PR description and relevant comments for screenshots and videos before requesting or uploading anything. Reuse evidence that still represents the changed UI at the reviewed head and covers the important scenario. A newer commit does not require a new recording when it leaves the demonstrated behavior unchanged; explain how you checked that. Replace outdated or incomplete evidence rather than duplicating it.

The implementation agent should capture and attach media when opening or updating a UI PR. The reviewer checks that coverage and, if needed, hands a concrete request to the existing implementation agent. Do not spawn an agent or change reviewed code to obtain a demo. If handoff is unavailable, put the request and verification gap in the review context. A useful request includes:

- The PR URL, reviewed head, affected screen, and purpose of the change.
- How to run/reach the feature, viewport, and test data when known.
- The exact interaction and resulting states to show, and screenshots to capture.
- A request to upload the artifacts to the PR and return their GitHub URLs, captured head, and any limits.

When suitable browser/computer-use tools and a runnable reviewed version are already available, the reviewer may capture evidence without modifying the repository. Follow its existing run instructions. If setup requires code changes, hand that work back rather than patching the reviewed tree. Never describe a mock or a different checkout as the working reviewed feature.

## Capture a clean demonstration

Use the product-native collaborative browser/computer-use tools when available. For T3 Code, call `preview_status`; if no automation-capable preview is attached, call `preview_open`. Navigate to the runnable reviewed version, inspect the page, and use semantic locators from its snapshot for interactions. Use another computer-use system only when the T3 preview tools are absent, explicitly unsupported/unavailable, or the user requests it.

Prepare the screen before recording: choose a viewport that makes the changed UI readable, navigate to the relevant state, and let unrelated startup/loading finish. Use appropriate demonstration data and keep unrelated tabs, desktop content, notifications, credentials, and private data out of the capture. Save artifacts outside the reviewed tree.

For T3 browser capture:

1. Call `preview_snapshot` with `save: true` for the important initial state. Keep its `screenshotPath`.
2. Call `preview_recording_start` on that tab.
3. Perform the shortest interaction that explains the change using `preview_click`, `preview_type`, `preview_press`, or other focused tools. Show the relevant button being clicked and the visible result, including changed loading/error states when those are the PR's purpose. Pause only long enough for viewers to understand the result.
4. Call `preview_recording_stop` on the same tab promptly, including after an interaction failure. Keep the returned local path. Capture important result screenshots with `preview_snapshot` and `save: true`.

Aim for roughly 10–30 seconds when that covers the scenario; use separate short clips for distinct changes when clearer. Exclude setup, dead time, and unrelated app navigation. Retake or trim a messy recording. If the feature is not interactive yet but the changed UI renders, record a short focused view of it and explicitly label the unverified interaction. If it cannot render or recording is unavailable, provide available screenshots and state the concrete limitation; do not invent a successful demonstration.

Verify the recording saved successfully and check its relevant beginning/result frames with available media tools. Inspect a few selected frames rather than feeding every frame to the model by default. State separately which behavior was actually exercised; video evidence does not replace correctness checks.

## Upload and report

For a PR-opening workflow, attach evidence when creating the PR. During review, attach missing evidence to that same PR description or a conversation comment when publication is authorized. A local-only review must not upload or post anything; retain local artifact paths and the capture request in its local report.

Use a supported authenticated GitHub attachment uploader. GitHub CLI attachments require push access to the target repository; if the signed-in account lacks it, use an authorized account or hand the upload back to a maintainer. Check the installed `gh` command's help before using `--attach`; older versions lack it. A compatible GitHub CLI can upload media and rewrite local references from a Markdown body file into hosted URLs:

```sh
gh pr create --title "PR title" --body-file /tmp/pr-body.md \
  --attach /tmp/ui-before.png --attach /tmp/ui-after.png --attach /tmp/ui-demo.mp4

gh pr comment https://github.com/OWNER/REPO/pull/NUMBER \
  --body-file /tmp/ui-evidence.md \
  --attach /tmp/ui-after.png --attach /tmp/ui-demo.mp4
```

Use the create example only when actually opening a PR; use its existing URL during review. Write actual newlines in the body file. Image references can use `![Changed state](/tmp/ui-after.png)`; a video reference such as `![](/tmp/ui-demo.mp4)` must be its own paragraph to render as a player after upload. Include a short scenario caption and captured head. Check current [GitHub CLI attachment documentation](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli) and [file formats and limits](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files) if upload compatibility is uncertain. Prefer a broadly playable MP4 when conversion is needed, and keep clips small enough for the repository's plan and recorder's transfer limit.

If the installed CLI lacks attachment support, use another available supported uploader or authenticated browser with file-attachment support. `gh api` posting a Markdown local path does not upload the file. If no upload route is available, preserve the artifacts and report the upload blocker with a concrete handoff; never claim local paths are GitHub attachments. Inspect the PR after an uncertain write before retrying, and avoid duplicate evidence comments.

Verify that the uploaded media is accessible from the PR. Put the hosted URLs or a link to the existing evidence comment in the Markdown supplied to `benedict publish --context-file`, along with the demonstrated scenario, captured head, and any interaction/capture/upload gaps. The review CLI does not record or upload media. Keep the evidence in Markdown, outside finding JSON, and keep the confidence rationale consistent with actual verification.
