import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import type { Finding } from "../src/model.js"
import { parsePullRequest, renderReview } from "../src/comment.js"
import { infisicalProject } from "../src/infisical.js"

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url))
const prUrl = "https://github.com/example/project/pull/42"
const draft: Finding = {
  file: "src.ts", startLine: 1, endLine: 1, severity: "high", skill: "correctness",
  title: "Invalid result", explanation: "This value causes the observed failure.",
  quote: "export const value = 0;", confidence: 0.9
}

// Runs the real built CLI with a fake read-only gh, a fake Infisical CLI and a fake GitHub API; every call is recorded.
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
const fakeInfisical = `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.BENEDICT_LOG, JSON.stringify({infisical: process.argv.slice(2)})+'\\n');
const mode = process.env.INFISICAL_TEST_MODE;
if (mode === 'logged-out') { process.stderr.write('You must be logged in to run this command.'); process.exit(1); }
const secrets = [{key:'BENEDICT_APP_ID',value:'12345'}, ...(mode === 'missing-key' ? [] : [{key:'BENEDICT_APP_PRIVATE_KEY',value:process.env.TEST_APP_PEM}])];
process.stdout.write(JSON.stringify(secrets.map(secret => ({...secret, type:'shared', workspace:'project'}))));
`
const fakeGitHub = `import fs from 'node:fs';
const pr = 'https://github.com/example/project/pull/42';
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const path = new URL(request.url).pathname;
  const text = await request.text();
  const body = text ? JSON.parse(text) : undefined;
  fs.appendFileSync(process.env.BENEDICT_LOG, JSON.stringify({github: {method: request.method, path, authorization: request.headers.get('authorization'), body, redirect: init?.redirect}})+'\\n');
  const state = JSON.parse(fs.readFileSync(process.env.BENEDICT_GH_STATE, 'utf8'));
  const mode = process.env.GITHUB_TEST_MODE;
  const json = (value, status = 200) => new Response(JSON.stringify(value), {status});
  const route = request.method + ' ' + path.replace('/repos/example/project', '');
  if (route === 'GET /installation') return mode === 'not-installed' ? json({message:'Not Found'}, 404) : json({id:9, app_slug:'benedict'});
  if (path === '/app/installations/9/access_tokens') return json({token:'installation-token'});
  if (route === 'GET /pulls/42') return json(state.pr);
  if (route === 'GET /pulls/42/reviews') return json([]);
  if (route === 'POST /pulls/42/reviews') {
    if (mode === 'lose-review') throw new Error('connection reset');
    if (mode === 'reject-approval' && body.event === 'APPROVE') return json({message:'Can not approve your own pull request'}, 422);
    return json({state: body.event === 'APPROVE' ? 'APPROVED' : 'COMMENTED', commit_id:body.commit_id, html_url:pr+'#pullrequestreview-99', body:body.body, user:{login:'benedict[bot]'}});
  }
  if (route.startsWith('GET /compare/')) return json({merge_base_commit:{sha:state.pr.base.sha}});
  return json({message:'Unexpected ' + route}, 500);
};
`
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()

type Call = {
  gh?: { method: string; endpoint: string; args: string[] }
  infisical?: string[]
  github?: { method: string; path: string; authorization: string | null; body?: { body?: string; event?: string; commit_id?: string; comments?: Array<{ path: string; line: number }> }; redirect: string }
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
  const hook = join(root, "github.mjs")
  for (const [name, script] of [["gh", fakeGh], ["infisical", fakeInfisical]] as const) {
    writeFileSync(join(bin, name), script)
    chmodSync(join(bin, name), 0o755)
  }
  writeFileSync(hook, fakeGitHub)
  writeFileSync(input, JSON.stringify([draft]))
  writeFileSync(notes, "Verified the caller and ran the focused test.\n")
  const initial = { pr: { state: "open", base: { sha: base }, head: { sha: head } }, files: [{ filename: "src.ts", patch: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 0;" }] }
  writeFileSync(statePath, JSON.stringify(initial))
  const state = (changes: object) => writeFileSync(statePath, JSON.stringify({ ...initial, ...changes }))
  const calls = (): Call[] => {
    try { return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error }
  }
  const github = () => calls().flatMap(call => call.github ? [call.github] : [])
  // Token creation is not a PR write.
  const writes = () => github().filter(call => call.method !== "GET" && call.path.startsWith("/repos/"))
  const run = (args: string[] = [], env: Record<string, string> = {}) => spawnSync(process.execPath, [
    "--import", hook, cli, "publish", input, "--pr", prUrl,
    ...(args.includes("--confidence") ? [] : ["--confidence", "4"]),
    ...(args.includes("--decision") ? [] : ["--decision", "comment"]), ...args
  ], {
    cwd: repo, encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, BENEDICT_GH_STATE: statePath, BENEDICT_LOG: logPath,
      TEST_APP_PEM: pem,
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
  return { repo, input, notes, base, head, initial, state, calls, github, writes, run, success, failure, git }
}

test("publication validates drafts, labels AI and posts as the GitHub App without editing the repo", (t) => {
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
  const [review, ...others] = f.writes()
  assert.equal(others.length, 0)
  assert.equal(review!.path, "/repos/example/project/pulls/42/reviews")
  assert.equal(review!.body!.event, "COMMENT")
  assert.equal(review!.body!.commit_id, f.head)
  assert.equal(review!.body!.body, result.body)
  assert.deepEqual(review!.body!.comments!.map(comment => [comment.path, comment.line]), [["src.ts", 1]])
  assert.equal(review!.authorization, "Bearer installation-token")
  for (const call of f.github()) assert.equal(call.redirect, "error")
  assert.deepEqual(f.calls().flatMap(call => call.gh ? [call.gh.endpoint] : []), ["repos/example/project/pulls/42", "repos/example/project/pulls/42/files?per_page=100&page=1"])
  for (const call of f.calls()) if (call.gh) assert.deepEqual(call.gh.args.slice(1, 5), ["--hostname", "github.com", "--method", "GET"])
  assert.ok(!JSON.stringify(result).includes("PRIVATE KEY"))
  assert.equal(f.git("status", "--porcelain"), status)
})

test("app credentials come from the hardcoded Infisical project through the developer's login", (t) => {
  const f = fixture(t)
  f.success()
  assert.deepEqual(f.calls().flatMap(call => call.infisical ? [call.infisical] : []), [
    ["export", "--projectId", infisicalProject.id, "--env", infisicalProject.environment, "--format", "json", "--silent"]
  ])
  const writes = f.writes().length
  const loggedOut = f.failure([], { INFISICAL_TEST_MODE: "logged-out" })
  assert.equal(loggedOut.code, "app_credentials")
  assert.match(loggedOut.message, /You must be logged in/)
  assert.match(loggedOut.message, /infisical login/)
  assert.equal(f.failure([], { INFISICAL_TEST_MODE: "missing-key" }).code, "app_credentials")
  assert.equal(f.writes().length, writes)
})

test("dry-run renders the exact review, only reads the PR and its diff and needs no app credentials", (t) => {
  const f = fixture(t)
  const result = f.run(["--dry-run"], { INFISICAL_TEST_MODE: "logged-out" })
  assert.equal(result.status, 0, result.stderr)
  const preview = JSON.parse(result.stdout)
  assert.equal(preview.action, "dry-run")
  assert.equal(preview.reviewUrl, null)
  assert.deepEqual(f.calls().map(call => call.gh?.method), ["GET", "GET"])
  const posted = f.success()
  assert.equal(posted.body, preview.body)
  assert.deepEqual(posted.comments, preview.comments)
})

test("--decision approve approves as the app and reports a refusal with exit 1 after publishing", (t) => {
  const f = fixture(t)
  const approved = f.success("--decision", "approve", "--confidence", "3")
  assert.deepEqual(approved.approval, { action: "approved", url: `${prUrl}#pullrequestreview-99` })
  assert.equal(approved.decision, "approve")
  const [approval] = f.writes()
  assert.equal(approval!.body!.event, "APPROVE")
  assert.equal(approval!.body!.commit_id, f.head)
  assert.match(approval!.body!.body!, /Overall confidence: \*\*3\/5\*\*/)
  const refused = f.run(["--decision", "approve", "--format", "text"], { GITHUB_TEST_MODE: "reject-approval" })
  assert.equal(refused.status, 1, refused.stderr)
  assert.match(refused.stdout, /^created: https:\/\/github.com\/example\/project\/pull\/42#pullrequestreview-99\napproval refused \(write_rejected\): .*Can not approve your own pull request/)
  assert.deepEqual(f.writes().map(write => write.body!.event), ["APPROVE", "APPROVE", "COMMENT"])
  assert.equal(f.run(["--approve"]).status, 2)
  assert.equal(f.run(["--decision", "maybe"]).status, 2)
})

test("confidence and decision are required, and confidence is an integer from 1 to 5", (t) => {
  const f = fixture(t)
  assert.equal(f.failure(["--confidence", "6"]).code, "input_error")
  assert.equal(f.failure(["--confidence", "0"]).code, "input_error")
  for (const args of [["--decision", "comment"], ["--confidence", "4"]]) {
    const missing = spawnSync(process.execPath, [cli, "publish", f.input, "--pr", prUrl, ...args], { cwd: f.repo, encoding: "utf8" })
    assert.equal(missing.status, 2)
  }
  assert.equal(f.calls().length, 0)
})

test("closed PRs, stale heads and ranges outside the PR fail before reading credentials", (t) => {
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
  assert.ok(f.calls().every(call => call.gh))
})

test("a lost write is uncertain and not retried; an uninstalled app is a definite refusal", (t) => {
  const f = fixture(t)
  const uncertain = f.failure([], { GITHUB_TEST_MODE: "lose-review" })
  assert.equal(uncertain.code, "write_uncertain")
  assert.match(uncertain.message, /rerun the same command/)
  assert.equal(f.writes().length, 1)
  const refused = f.failure([], { GITHUB_TEST_MODE: "not-installed" })
  assert.equal(refused.code, "repository_disabled")
  assert.equal(f.writes().length, 1)
})

test("invalid targets, missing context, malformed gh output and excessive content do not post", (t) => {
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
  assert.equal(f.github().length, 0)
})

test("empty findings still publish a useful summary and optional context", (t) => {
  const f = fixture(t)
  writeFileSync(f.input, "[]")
  const result = f.success("--context-file", f.notes, "--format", "json")
  assert.deepEqual(result.summary, { accepted: 0, rejected: 0 })
  assert.match(result.body, /nothing that cleared/)
  assert.match(result.body, /Verified the caller/)
})

test("publish checks skills and supports explicit reviewed commits and text preview", (t) => {
  const f = fixture(t)
  writeFileSync(f.input, JSON.stringify([draft, { ...draft, title: "Unknown skill", skill: "performance" }]))
  const result = f.success("--base", f.base, "--head", f.head)
  assert.deepEqual(result.summary, { accepted: 1, rejected: 1 })
  assert.ok(!result.body.includes("Unknown skill"))
  const text = f.run(["--dry-run", "--format", "text"])
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /dry-run: https:\/\/github.com/)
  assert.match(text.stdout, /AI-generated review/)
  assert.match(text.stdout, /\n--- src\.ts:1 ---\n### Invalid result\n/)
  assert.equal(f.run(["--worktree"]).status, 2)
  assert.equal(f.run(["--config", "other.json"]).status, 2)
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
  assert.ok(body.includes(`Organization skills revision: \`${"c".repeat(40)}\``))
})
