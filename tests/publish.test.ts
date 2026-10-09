import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import type { Finding } from "../src/model.js"
import { commentMarker, parsePullRequest, renderComment } from "../src/publish.js"

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url))
const prUrl = "https://github.com/example/project/pull/42"
const draft: Finding = {
  file: "src.ts", startLine: 1, endLine: 1, severity: "high", skill: "correctness",
  title: "Invalid result", explanation: "This value causes the observed failure.",
  quote: "export const value = 0;", confidence: 0.9
}

// Runs the real built CLI with a fake gh executable; every API call and stdin is recorded.
const fakeGh = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const method = args[args.indexOf('--method') + 1];
const endpoint = args[args.indexOf('--header') + 2];
const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
fs.appendFileSync(process.env.REVIEW_GH_LOG, JSON.stringify({method,endpoint,body,args})+'\\n');
const state = JSON.parse(fs.readFileSync(process.env.REVIEW_GH_STATE, 'utf8'));
let result;
if (endpoint === 'user') result = {id: 7};
else if (method === 'GET' && endpoint.includes('/pulls/')) {
  state.prReads = (state.prReads || 0) + 1;
  result = state.prReads >= 2 && state.changedPr ? state.changedPr : state.pr;
} else if (method === 'GET' && endpoint.includes('/comments?')) {
  const page = Number(new URLSearchParams(endpoint.split('?')[1]).get('page'));
  result = state.comments.slice((page-1)*100,page*100);
} else if (method === 'POST') {
  result = {id: 999, html_url: '${prUrl}#issuecomment-999', user: {id: 7}, body: body.body};
  state.comments.push(result);
} else if (method === 'PATCH') {
  const id = Number(endpoint.split('/').at(-1));
  result = state.comments.find(comment => comment.id === id);
  if (!result || result.user.id !== 7) throw new Error('Attempted to edit another author');
  result.body = body.body;
} else throw new Error('Unexpected API request: ' + endpoint);
fs.writeFileSync(process.env.REVIEW_GH_STATE, JSON.stringify(state));
if (state.failMethod === method) { process.stderr.write('simulated connection failure'); process.exit(1); }
process.stdout.write(state.invalidJson ? '{' : JSON.stringify(result));
`

type FakeComment = { id: number; user: { id: number }; body: string; html_url: string }
const comment = (id: number, author: number, body: string): FakeComment => ({ id, user: { id: author }, body, html_url: `${prUrl}#issuecomment-${id}` })

const fixture = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "review-publish-"))
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
  const ghPath = join(bin, "gh")
  writeFileSync(ghPath, fakeGh)
  chmodSync(ghPath, 0o755)
  writeFileSync(input, JSON.stringify([draft]))
  writeFileSync(notes, "Verified the caller and ran the focused test.\n")
  const initial = { pr: { state: "open", base: { sha: base }, head: { sha: head } }, comments: [] as FakeComment[] }
  writeFileSync(statePath, JSON.stringify(initial))
  const state = (changes: object) => writeFileSync(statePath, JSON.stringify({ ...initial, ...changes }))
  const calls = () => {
    try { return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) as Array<{ method: string; endpoint: string; body: { body: string } | null; args: string[] }> }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error }
  }
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "publish", input, "--pr", prUrl, ...args], {
    cwd: repo, encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, REVIEW_GH_STATE: statePath, REVIEW_GH_LOG: logPath,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GH_HOST: "wrong.example.invalid"
    }
  })
  const success = (...args: string[]) => {
    const result = run(...args)
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  return { repo, input, notes, base, head, initial, state, calls, run, success, git }
}

test("publication validates drafts, sends JSON stdin, labels AI and includes context without editing the repo", (t) => {
  const f = fixture(t)
  const explanation = `Literal shell text: $(touch ${join(f.repo, "should-not-exist")}) and backticks \`code\`.\nSecond line.`
  writeFileSync(f.input, JSON.stringify([{ ...draft, explanation }, { ...draft, title: "Rejected private draft", quote: "nonexistent" }]))
  const status = f.git("status", "--porcelain")
  const result = f.success("--context-file", f.notes)
  assert.equal(result.action, "created")
  assert.deepEqual(result.summary, { accepted: 1, rejected: 1 })
  assert.equal(result.range.base, f.base)
  assert.equal(result.range.head, f.head)
  assert.match(result.body, /AI-generated review/)
  assert.match(result.body, /review skill and CLI automated reviewer/)
  assert.match(result.body, /does not indicate human authorship/)
  assert.ok(result.body.includes(explanation))
  assert.match(result.body, /Verified the caller/)
  assert.ok(!result.body.includes("Rejected private draft"))
  assert.match(result.body, new RegExp(`/blob/${f.head}/src.ts#L1-L1`))
  const writes = f.calls().filter(call => call.method !== "GET")
  assert.equal(writes.length, 1)
  assert.equal(writes[0]?.body?.body, result.body)
  assert.deepEqual(writes[0]?.args.slice(-2), ["--input", "-"])
  for (const call of f.calls()) assert.deepEqual(call.args.slice(1, 3), ["--hostname", "github.com"])
  assert.equal(f.git("status", "--porcelain"), status)
})

test("dry-run renders exact content and only reads PR metadata", (t) => {
  const f = fixture(t)
  const preview = f.success("--dry-run")
  assert.equal(preview.action, "dry-run")
  assert.equal(preview.commentUrl, null)
  assert.deepEqual(f.calls().map(call => [call.method, call.endpoint]), [["GET", "repos/example/project/pulls/42"]])
  assert.equal(f.success().body, preview.body)
})

test("repeat runs update one owned comment, then skip an unchanged write", (t) => {
  const f = fixture(t)
  assert.equal(f.success().action, "created")
  assert.equal(f.success("--context-file", f.notes).action, "updated")
  const again = f.success("--context-file", f.notes)
  assert.equal(again.action, "unchanged")
  assert.equal(again.commentUrl, `${prUrl}#issuecomment-999`)
  assert.deepEqual(f.calls().filter(call => call.method !== "GET").map(call => call.method), ["POST", "PATCH"])
})

test("human comments and another author's automation marker remain untouched", (t) => {
  const f = fixture(t)
  f.state({ comments: [comment(1, 7, "Human review"), comment(2, 8, `${commentMarker}\n\nForeign review`), comment(3, 7, `Quoted marker: ${commentMarker}\n`)] })
  assert.equal(f.success().action, "created")
  assert.deepEqual(f.calls().filter(call => call.method !== "GET").map(call => call.method), ["POST"])
})

test("pagination finds an owned comment beyond the first hundred", (t) => {
  const f = fixture(t)
  f.state({ comments: [
    ...Array.from({ length: 100 }, (_, index) => comment(index + 1, 8, "Discussion")),
    comment(101, 7, `${commentMarker}\n\nPrior review`)
  ] })
  assert.equal(f.success().action, "updated")
  assert.ok(f.calls().some(call => call.endpoint.endsWith("page=2")))
  assert.equal(f.calls().at(-1)?.endpoint, "repos/example/project/issues/comments/101")
})

test("ambiguous owned comments fail without a write", (t) => {
  const f = fixture(t)
  f.state({ comments: [comment(1, 7, `${commentMarker}\n`), comment(2, 7, `${commentMarker}\n`)] })
  const result = f.run()
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stderr).error.code, "ambiguous_comment")
  assert.ok(f.calls().every(call => call.method === "GET"))
})

test("closed PRs and stale reviewed heads fail before publishing", (t) => {
  const f = fixture(t)
  for (const [pr, expected] of [
    [{ ...f.initial.pr, state: "closed" }, "pr_closed"],
    [{ ...f.initial.pr, head: { sha: "a".repeat(40) } }, "stale_review"]
  ] as const) {
    f.state({ pr })
    const result = f.run("--base", f.base)
    assert.equal(result.status, 2)
    assert.equal(JSON.parse(result.stderr).error.code, expected)
  }
  assert.ok(f.calls().every(call => call.method === "GET"))
})

test("reviewed ranges cannot include commits before the PR merge base", (t) => {
  const f = fixture(t)
  f.state({ pr: { ...f.initial.pr, base: { sha: f.head } } })
  const result = f.run("--base", f.base)
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stderr).error.code, "range_error")
  assert.match(JSON.parse(result.stderr).error.message, /outside the PR range/)
  assert.ok(f.calls().every(call => call.method === "GET"))
})

test("PR changes between validation and the write fail closed", (t) => {
  const f = fixture(t)
  for (const changedPr of [
    { ...f.initial.pr, head: { sha: "b".repeat(40) } },
    { ...f.initial.pr, base: { sha: "b".repeat(40) } },
    { ...f.initial.pr, state: "closed" }
  ]) {
    f.state({ changedPr })
    const result = f.run()
    assert.equal(result.status, 2)
    assert.equal(JSON.parse(result.stderr).error.code, "stale_review")
  }
  assert.ok(f.calls().every(call => call.method === "GET"))
})

test("a lost write response is not automatically retried; the next run discovers the landed comment", (t) => {
  const f = fixture(t)
  f.state({ failMethod: "POST" })
  const result = f.run()
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stderr).error.code, "github_error")
  assert.match(JSON.parse(result.stderr).error.message, /may have reached GitHub/)
  assert.equal(f.calls().filter(call => call.method === "POST").length, 1)
  // The fake server saved the write, but the client did not receive its response.
  assert.equal(f.success().action, "unchanged")
  assert.equal(f.calls().filter(call => call.method === "POST").length, 1)
})

test("invalid targets, missing context, malformed gh output and excessive content do not write", (t) => {
  const f = fixture(t)
  assert.throws(() => parsePullRequest("https://github.com/example/project/issues/42"))
  assert.throws(() => parsePullRequest("https://other.example/example/project/pull/42"))
  assert.throws(() => parsePullRequest("https://github.com/example/project/pull/42?extra=true"))
  assert.equal(f.run("--context-file", join(f.repo, "missing.md")).status, 2)
  assert.equal(f.calls().length, 0)
  f.state({ invalidJson: true })
  assert.equal(f.run().status, 2)
  f.state({})
  writeFileSync(f.notes, "x".repeat(60_000))
  const large = f.run("--context-file", f.notes)
  assert.equal(large.status, 2)
  assert.equal(JSON.parse(large.stderr).error.code, "comment_too_large")
  assert.ok(f.calls().every(call => call.method === "GET"))
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
  mkdirSync(join(f.repo, ".review"), { recursive: true })
  writeFileSync(join(f.repo, ".review/config.json"), JSON.stringify({ minimumConfidence: 0.95 }))
  const result = f.success("--base", f.base, "--head", f.head)
  assert.deepEqual(result.summary, { accepted: 0, rejected: 1 })
  assert.ok(!result.body.includes(draft.title))
  const text = f.run("--dry-run", "--format", "text")
  assert.equal(text.status, 0, text.stderr)
  assert.match(text.stdout, /dry-run: https:\/\/github.com/)
  assert.match(text.stdout, /AI-generated review/)
  assert.equal(f.run("--worktree").status, 2)
})

test("comment rendering preserves code fences and encodes unusual source paths", () => {
  const body = renderComment({
    formatVersion: 1, repository: "/local", range: { base: "a".repeat(40), head: "b".repeat(40), worktree: false },
    organization: { version: 1, source: "https://example.com/private-knowledge.git", ref: "main", revision: "c".repeat(40) },
    summary: { accepted: 1, rejected: 0 }, rejected: [],
    accepted: [{ ...draft, file: "a (b)#.ts", title: "Title\n## <script>", quote: "```\ncode\n```", suggestedFix: "Keep the original value." }]
  }, "example/project")
  assert.ok(body.includes("a%20%28b%29%23.ts#L1-L1"))
  assert.ok(body.includes("````\n```\ncode\n```\n````"))
  assert.ok(!body.includes("\n## <script>"))
  assert.match(body, /Suggested fix: Keep the original value/)
  assert.ok(body.includes(`Organization knowledge revision: \`${"c".repeat(40)}\``))
  assert.ok(!body.includes("private-knowledge"))
})
