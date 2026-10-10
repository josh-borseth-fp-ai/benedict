import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import type { Finding } from "../src/model.js"
import { parsePullRequest, renderReview } from "../src/comment.js"

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url))
const prUrl = "https://github.com/example/project/pull/42"
const draft: Finding = {
  file: "src.ts", startLine: 1, endLine: 1, severity: "high", skill: "correctness",
  title: "Invalid result", explanation: "This value causes the observed failure.",
  quote: "export const value = 0;", confidence: 0.9
}

// Runs the real built CLI with a fake read-only gh and a fake Benedict service; every call is recorded.
const fakeGh = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const method = args[args.indexOf('--method') + 1];
const endpoint = args[args.indexOf('--header') + 2];
fs.appendFileSync(process.env.BENEDICT_LOG, JSON.stringify({gh: {method,endpoint,args}})+'\\n');
const state = JSON.parse(fs.readFileSync(process.env.BENEDICT_GH_STATE, 'utf8'));
if (method !== 'GET' || !endpoint.includes('/pulls/')) throw new Error('Unexpected API request: ' + method + ' ' + endpoint);
process.stdout.write(state.invalidJson ? '{' : JSON.stringify(endpoint.includes('/files?') ? state.files : state.pr));
`
const fakeService = `import fs from 'node:fs';
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(typeof options.body === 'string' ? options.body : Buffer.from(options.body).toString('utf8'));
  fs.appendFileSync(process.env.BENEDICT_LOG, JSON.stringify({service: {url, headers: options.headers, body, redirect: options.redirect}})+'\\n');
  const mode = process.env.SERVICE_TEST_MODE;
  if (mode === 'fail') throw new Error('unknown outcome');
  if (mode === 'refuse') return new Response(JSON.stringify({error:{code:'stale_review',message:'The review is stale; review the current PR head.'}}),{status:409});
  const approval = !body.approve ? null : mode === 'approval-refused'
    ? {action:'refused',code:'protected_path',message:'A protected path changed: infra/main.tf.'}
    : {action:'approved',url:body.pr+'#pullrequestreview-99'};
  return new Response(JSON.stringify({pr:body.pr,head:body.head,postedBy:'benedict[bot]',review:{action:'created',url:body.pr+'#pullrequestreview-99'},approval}),{status:200});
};
`

type Call = {
  gh?: { method: string; endpoint: string; args: string[] }
  service?: { url: string; headers: Record<string, string>; body: { version: number; pr: string; base: string; head: string; findings: Finding[]; dropped: number; confidence: number; context: string; approve: boolean; organizationRevision: string | null }; redirect: string }
}

const fixture = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "benedict-publish-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, "repo")
  const bin = join(root, "bin")
  mkdirSync(repo)
  mkdirSync(bin)
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
  }).trim()
  git("init", "--quiet")
  git("config", "user.name", "Test")
  git("config", "user.email", "test@example.invalid")
  git("config", "commit.gpgsign", "false")
  writeFileSync(join(repo, "src.ts"), "export const value = 1;\n")
  git("add", ".")
  git("commit", "--quiet", "-m", "base")
  const base = git("rev-parse", "HEAD")
  writeFileSync(join(repo, "src.ts"), `${draft.quote}\n`)
  git("add", ".")
  git("commit", "--quiet", "-m", "head")
  const head = git("rev-parse", "HEAD")
  const statePath = join(root, "state.json")
  const logPath = join(root, "calls.jsonl")
  const input = join(root, "findings.json")
  const notes = join(root, "notes.md")
  const hook = join(root, "service.mjs")
  const ghPath = join(bin, "gh")
  writeFileSync(ghPath, fakeGh)
  chmodSync(ghPath, 0o755)
  writeFileSync(hook, fakeService)
  writeFileSync(input, JSON.stringify([draft]))
  writeFileSync(notes, "Verified the caller and ran the focused test.\n")
  const initial = { pr: { state: "open", base: { sha: base }, head: { sha: head } }, files: [{ filename: "src.ts", patch: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 0;" }] }
  writeFileSync(statePath, JSON.stringify(initial))
  const state = (changes: object) => writeFileSync(statePath, JSON.stringify({ ...initial, ...changes }))
  const calls = (): Call[] => {
    try { return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error }
  }
  const requests = () => calls().flatMap(call => call.service ? [call.service] : [])
  const run = (args: string[] = [], env: Record<string, string> = {}) => spawnSync(process.execPath, [
    "--import", hook, cli, "publish", input, "--pr", prUrl,
    ...(args.includes("--confidence") ? [] : ["--confidence", "4"]), ...args
  ], {
    cwd: repo, encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, BENEDICT_GH_STATE: statePath, BENEDICT_LOG: logPath,
      BENEDICT_SERVICE_URL: "https://benedict.example.invalid", BENEDICT_SERVICE_KEY: "test-key",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GH_HOST: "wrong.example.invalid", ...env
    }
  })
  const success = (...args: string[]) => {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const failure = (args: string[] = [], env: Record<string, string> = {}) => {
    const result = run(args, env)
    assert.equal(result.status, 2, result.stdout)
    return JSON.parse(result.stderr).error as { code: string; message: string }
  }
  return { repo, input, notes, base, head, initial, state, calls, requests, run, success, failure, git }
}

test("publication validates drafts, labels AI and sends the review to the trusted service without editing the repo", (t) => {
  const f = fixture(t)
  const explanation = `Literal shell text: $(touch ${join(f.repo, "should-not-exist")}) and backticks \`code\`.\nSecond line.`
  writeFileSync(f.input, JSON.stringify([{ ...draft, explanation }, { ...draft, title: "Rejected private draft", quote: "nonexistent" }]))
  const status = f.git("status", "--porcelain")
  const result = f.success("--context-file", f.notes)
  assert.equal(result.action, "created")
  assert.equal(result.reviewUrl, `${prUrl}#pullrequestreview-99`)
  assert.equal(result.postedBy, "benedict[bot]")
  assert.equal(result.approval, null)
  assert.deepEqual(result.summary, { accepted: 1, rejected: 1 })
  assert.equal(result.range.base, f.base)
  assert.equal(result.range.head, f.head)
  assert.match(result.body, /AI-generated review/)
  assert.match(result.body, /Benedict GitHub App posted it/)
  assert.match(result.body, /does not indicate human authorship/)
  assert.match(result.body, /Overall confidence: \*\*4\/5\*\*/)
  assert.match(result.body, /Accepted findings: \*\*1\*\* \(1 inline\)/)
  assert.deepEqual(result.comments.map(({ body, ...anchor }: { body: string }) => anchor), [{ path: "src.ts", startLine: 1, line: 1 }])
  assert.ok(result.comments[0].body.includes(explanation))
  assert.ok(!JSON.stringify(result).includes("Rejected private draft"))
  const [request, ...others] = f.requests()
  assert.equal(others.length, 0)
  assert.equal(request!.url, "https://benedict.example.invalid/api/reviews")
  assert.equal(request!.headers["x-benedict-key"], "test-key")
  assert.equal(request!.redirect, "error")
  assert.deepEqual(request!.body, {
    version: 1, pr: prUrl, base: f.base, head: f.head, organizationRevision: null,
    findings: [{ ...draft, explanation }], dropped: 1, confidence: 4,
    context: "Verified the caller and ran the focused test.\n", approve: false
  })
  assert.deepEqual(f.calls().flatMap(call => call.gh ? [call.gh.endpoint] : []), ["repos/example/project/pulls/42", "repos/example/project/pulls/42/files?per_page=100&page=1"])
  for (const call of f.calls()) if (call.gh) assert.deepEqual(call.gh.args.slice(1, 5), ["--hostname", "github.com", "--method", "GET"])
  assert.ok(!JSON.stringify(result).includes("test-key"))
  assert.equal(f.git("status", "--porcelain"), status)
})

test("dry-run renders the exact review, only reads the PR and its diff and needs no service settings", (t) => {
  const f = fixture(t)
  const result = f.run(["--dry-run"], { BENEDICT_SERVICE_URL: "", BENEDICT_SERVICE_KEY: "" })
  assert.equal(result.status, 0, result.stderr)
  const preview = JSON.parse(result.stdout)
  assert.equal(preview.action, "dry-run")
  assert.equal(preview.reviewUrl, null)
  assert.deepEqual(f.calls().map(call => call.gh?.method), ["GET", "GET"])
  const posted = f.success()
  assert.equal(posted.body, preview.body)
  assert.deepEqual(posted.comments, preview.comments)
})

test("--approve asks the app to approve and reports a refusal with exit 1 after publishing", (t) => {
  const f = fixture(t)
  writeFileSync(f.input, "[]")
  const approved = f.success("--approve", "--confidence", "5")
  assert.deepEqual(approved.approval, { action: "approved", url: `${prUrl}#pullrequestreview-99` })
  assert.equal(f.requests()[0]!.body.approve, true)
  assert.equal(f.requests()[0]!.body.confidence, 5)
  const refused = f.run(["--approve", "--format", "text"], { SERVICE_TEST_MODE: "approval-refused" })
  assert.equal(refused.status, 1, refused.stderr)
  assert.match(refused.stdout, /^created: https:\/\/github.com\/example\/project\/pull\/42#pullrequestreview-99\napproval refused \(protected_path\): A protected path changed/)
  assert.equal(f.run(["--stamp"]).status, 2)
})

test("confidence is required and must be an integer from 1 to 5", (t) => {
  const f = fixture(t)
  assert.equal(f.failure(["--confidence", "6"]).code, "input_error")
  assert.equal(f.failure(["--confidence", "0"]).code, "input_error")
  const missing = spawnSync(process.execPath, [cli, "publish", f.input, "--pr", prUrl], { cwd: f.repo, encoding: "utf8" })
  assert.equal(missing.status, 2)
  assert.equal(f.calls().length, 0)
})

test("closed PRs, stale heads and ranges outside the PR fail before contacting the service", (t) => {
  const f = fixture(t)
  for (const [pr, expected] of [
    [{ ...f.initial.pr, state: "closed" }, "pr_closed"],
    [{ ...f.initial.pr, head: { sha: "a".repeat(40) } }, "stale_review"]
  ] as const) {
    f.state({ pr })
    assert.equal(f.failure(["--base", f.base]).code, expected)
  }
  f.state({ pr: { ...f.initial.pr, base: { sha: f.head } } })
  const outside = f.failure(["--base", f.base])
  assert.equal(outside.code, "range_error")
  assert.match(outside.message, /outside the PR range/)
  assert.equal(f.requests().length, 0)
})

test("the key is only sent to the locally configured HTTPS service", (t) => {
  const f = fixture(t)
  assert.equal(f.failure([], { BENEDICT_SERVICE_URL: "" }).code, "service_auth")
  assert.equal(f.failure([], { BENEDICT_SERVICE_KEY: "" }).code, "service_auth")
  assert.equal(f.failure([], { BENEDICT_SERVICE_URL: "http://benedict.example.invalid" }).code, "service_auth")
  assert.equal(f.requests().length, 0)
})

test("a lost service response is uncertain and not retried; a refusal is definite", (t) => {
  const f = fixture(t)
  const uncertain = f.failure([], { SERVICE_TEST_MODE: "fail" })
  assert.equal(uncertain.code, "service_error")
  assert.match(uncertain.message, /may have reached GitHub/)
  assert.equal(f.requests().length, 1)
  const refused = f.failure([], { SERVICE_TEST_MODE: "refuse" })
  assert.equal(refused.code, "publish_refused")
  assert.match(refused.message, /stale_review/)
  assert.doesNotMatch(refused.message, /may have reached GitHub/)
})

test("invalid targets, missing context, malformed gh output and excessive content do not contact the service", (t) => {
  const f = fixture(t)
  assert.throws(() => parsePullRequest("https://github.com/example/project/issues/42"))
  assert.throws(() => parsePullRequest("https://other.example/example/project/pull/42"))
  assert.throws(() => parsePullRequest("https://github.com/example/project/pull/42?extra=true"))
  assert.equal(f.run(["--context-file", join(f.repo, "missing.md")]).status, 2)
  assert.equal(f.calls().length, 0)
  f.state({ invalidJson: true })
  assert.equal(f.run().status, 2)
  f.state({})
  writeFileSync(f.notes, "x".repeat(60_000))
  assert.equal(f.failure(["--context-file", f.notes]).code, "comment_too_large")
  assert.equal(f.requests().length, 0)
})

test("empty findings still publish a useful summary and optional context", (t) => {
  const f = fixture(t)
  writeFileSync(f.input, "[]")
  const result = f.success("--context-file", f.notes, "--format", "json")
  assert.deepEqual(result.summary, { accepted: 0, rejected: 0 })
  assert.match(result.body, /nothing that cleared/)
  assert.match(result.body, /Verified the caller/)
})

test("publish uses repository policy and supports explicit reviewed commits and text preview", (t) => {
  const f = fixture(t)
  mkdirSync(join(f.repo, ".benedict"), { recursive: true })
  writeFileSync(join(f.repo, ".benedict/config.json"), JSON.stringify({ minimumConfidence: 0.95 }))
  const result = f.success("--base", f.base, "--head", f.head)
  assert.deepEqual(result.summary, { accepted: 0, rejected: 1 })
  assert.ok(!result.body.includes(draft.title))
  const text = f.run(["--dry-run", "--format", "text"])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /dry-run: https:\/\/github.com/)
  assert.match(text.stdout, /AI-generated review/)
  writeFileSync(join(f.repo, ".benedict/config.json"), "{}")
  assert.match(f.run(["--dry-run", "--format", "text"]).stdout, /\n--- src\.ts:1 ---\n### Invalid result\n/)
  assert.equal(f.run(["--worktree"]).status, 2)
})

test("review rendering preserves code fences and encodes unusual source paths", () => {
  const { body, comments } = renderReview({
    base: "a".repeat(40), head: "b".repeat(40), organizationRevision: "c".repeat(40), dropped: 0, confidence: 4, context: "",
    findings: [{ ...draft, file: "a (b)#.ts", title: "Title\n## <script>", quote: "```\ncode\n```", suggestedFix: "Keep the original value." }]
  }, "example/project", new Map())
  assert.deepEqual(comments, [])
  assert.ok(body.includes("a%20%28b%29%23.ts#L1-L1"))
  assert.ok(body.includes("````\n```\ncode\n```\n````"))
  assert.ok(!body.includes("\n## <script>"))
  assert.match(body, /Suggested fix: Keep the original value/)
  assert.ok(body.includes(`Organization knowledge revision: \`${"c".repeat(40)}\``))
})
