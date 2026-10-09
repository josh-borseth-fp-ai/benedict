import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { commentMarker } from "../src/publish.js"
import { serviceUrl } from "../src/stamp.js"

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url))
const pr = "https://github.com/acme/project/pull/7"

const fixture = (t: TestContext, stamp: Record<string, unknown> = {}, headFiles: Record<string, string> = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "review-direct-stamp-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim()
  git("init", "--quiet")
  git("config", "user.name", "Test")
  git("config", "user.email", "test@example.invalid")
  git("config", "commit.gpgsign", "false")
  mkdirSync(join(dir, ".review"))
  writeFileSync(join(dir, ".review/config.json"), JSON.stringify({ stamp: { enabled: true, service: "https://stamp.example.invalid/api/stamp", ...stamp } }))
  writeFileSync(join(dir, "safe.ts"), "export const value = 1\n")
  git("add", ".")
  git("commit", "--quiet", "-m", "base")
  const base = git("rev-parse", "HEAD")
  writeFileSync(join(dir, "safe.ts"), "export const value = 2\n")
  for (const [file, content] of Object.entries(headFiles)) writeFileSync(join(dir, file), content)
  git("add", ".")
  git("commit", "--quiet", "-m", "head")
  const head = git("rev-parse", "HEAD")
  const findings = join(dir, "findings.json")
  const log = join(dir, "requests.jsonl")
  const state = join(dir, "state.json")
  const hook = join(dir, "fetch.mjs")
  const comments = join(dir, "comments.json")
  const reviewComment = (confidence = 4, reviewedHead = head) => [{
    html_url: `${pr}#issuecomment-55`, user: { id: 1 },
    body: `${commentMarker}\n## AI-generated review\n\nReviewed commits: \`${base}\` → \`${reviewedHead}\`.\n\nAccepted findings: **0**. Dropped drafts: **0**.\n\n### Review context\n\n**Confidence: ${confidence}/5**\n`
  }]
  writeFileSync(comments, JSON.stringify(reviewComment()))
  writeFileSync(findings, "[]")
  writeFileSync(state, JSON.stringify({ state: "open", draft: false, head: { sha: head }, base: { sha: base } }))
  const gh = join(dir, "gh")
  writeFileSync(gh, `#!${process.execPath}\nconst fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({gh:process.argv.slice(2)})+'\\n'); const endpoint=process.argv.at(-1); process.stdout.write(endpoint==='user'?'{"id":1}':endpoint.includes('/comments')?fs.readFileSync(${JSON.stringify(comments)},'utf8'):fs.readFileSync(${JSON.stringify(state)},'utf8'));\n`)
  chmodSync(gh, 0o755)
  writeFileSync(hook, `import fs from 'node:fs';
    globalThis.fetch = async (url, options) => {
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({url,headers:options.headers,body:JSON.parse(typeof options.body === 'string' ? options.body : Buffer.from(options.body).toString('utf8')),redirect:options.redirect})+'\\n');
      if (process.env.STAMP_TEST_FAILURE) throw new Error('unknown outcome');
      if (process.env.STAMP_TEST_REFUSAL) return new Response(JSON.stringify({error:{code:'protected_path',message:'A protected path changed: infra/main.tf.'}}),{status:409});
      return new Response(JSON.stringify({action:'approved',pr:${JSON.stringify(pr)},head:${JSON.stringify(head)},approvedBy:'reviewer',reviewUrl:${JSON.stringify(pr + "#pullrequestreview-99")}}),{status:200});
    };
  `)
  const run = (args: string[] = [], env: Record<string, string> = {}) => spawnSync(process.execPath, [
    "--import", hook, cli, "stamp", "approve", findings, "--pr", pr,
    ...(args.includes("--base") ? [] : ["--base", base]), "--head", head,
    ...(args.includes("--confidence") ? [] : ["--confidence", "4"]), ...args
  ], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, REVIEW_STAMP_KEY: "test-key", REVIEW_STAMP_URL: "https://stamp.example.invalid/api/stamp", ...env } })
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) as Array<{ gh?: string[]; url?: string; headers?: Record<string, string>; body?: { version: number; head: string; base: string; findings: unknown[]; confidence: number; reviewComment: string }; redirect?: string }>
  return { dir, base, head, state, findings, comments, reviewComment, run, calls, git }
}

test("stamp dry-run validates whole-PR range without sending an approval request", t => {
  const f = fixture(t)
  const result = f.run(["--dry-run"], { REVIEW_STAMP_KEY: "" })
  assert.equal(result.status, 0, result.stderr)
  const preview = JSON.parse(result.stdout)
  assert.equal(preview.action, "dry-run")
  assert.equal(preview.request.head, f.head)
  assert.deepEqual(preview.request.findings, [])
  assert.ok(f.calls().every(call => call.gh))
})

test("stamp calls the base-authorized service with the reviewed head and keeps auth out of reports", t => {
  const f = fixture(t)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).action, "approved")
  const requests = f.calls().filter(call => call.url)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.url, "https://stamp.example.invalid/api/stamp")
  assert.equal(requests[0]?.body?.head, f.head)
  assert.equal(requests[0]?.body?.base, f.base)
  assert.equal(requests[0]?.body?.version, 2)
  assert.equal(requests[0]?.body?.confidence, 4)
  assert.equal(requests[0]?.body?.reviewComment, `${pr}#issuecomment-55`)
  assert.equal(requests[0]?.headers?.["x-review-key"], "test-key")
  assert.equal(requests[0]?.redirect, "error")
  assert.ok(!result.stdout.includes("test-key"))
  assert.ok(!result.stderr.includes("test-key"))
})

test("stamp refuses findings, protected paths and excessive changes before sending", t => {
  for (const stamp of [{ denyPaths: ["safe.ts"] }, { maxChangedLines: 1 }]) {
    const f = fixture(t, stamp)
    const result = f.run()
    assert.equal(result.status, 2)
    assert.equal(JSON.parse(result.stderr).error.code, "stamp_refused")
    assert.ok(f.calls().every(call => call.gh))
  }
  const locked = fixture(t, {}, { ".review/knowledge.lock.json": "{}\n" })
  const refused = locked.run()
  assert.equal(refused.status, 2)
  assert.match(JSON.parse(refused.stderr).error.message, /protected by \.review\/\*\*/)
  const f = fixture(t)
  writeFileSync(f.findings, JSON.stringify([{ file: "safe.ts", startLine: 1, endLine: 1, severity: "high", skill: "correctness", title: "Actual issue", explanation: "A verified defect", quote: "export const value = 2", confidence: 0.9 }]))
  const result = f.run()
  assert.equal(result.status, 2)
  assert.match(result.stderr, /accepted findings/)
})

test("stamp refuses stale heads, partial ranges, missing auth and uncertain writes", t => {
  const f = fixture(t)
  writeFileSync(f.state, JSON.stringify({ state: "open", draft: false, head: { sha: f.base }, base: { sha: f.base } }))
  assert.match(f.run().stderr, /current whole PR/)
  writeFileSync(f.state, JSON.stringify({ state: "open", draft: false, head: { sha: f.head }, base: { sha: f.base } }))
  assert.match(f.run(["--base", f.head]).stderr, /current whole PR/)
  assert.match(f.run([], { REVIEW_STAMP_KEY: "" }).stderr, /REVIEW_STAMP_KEY/)
  const uncertain = f.run([], { STAMP_TEST_FAILURE: "1" })
  assert.equal(uncertain.status, 2)
  assert.match(uncertain.stderr, /may have reached GitHub/)
  assert.equal(f.calls().filter(call => call.url).length, 1)
})

test("service URLs cannot carry credentials or redirect authentication to HTTP", () => {
  for (const value of ["http://example.com/stamp", "https://user:password@example.com", "https://example.com?key=secret", "https://example.com#fragment"]) {
    assert.throws(() => serviceUrl(value))
  }
})

test("repository config cannot send the local service key to an untrusted endpoint", t => {
  const f = fixture(t)
  const result = f.run([], { REVIEW_STAMP_URL: "https://trusted.example.invalid/api/stamp" })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /does not match the locally trusted/)
  assert.ok(f.calls().every(call => call.gh))
})

test("stamp requires confidence of at least 4/5 that matches the published review", t => {
  const f = fixture(t)
  const low = f.run(["--confidence", "3"])
  assert.equal(low.status, 2)
  assert.match(low.stderr, /below 4\/5/)
  assert.equal(f.run(["--confidence", "6"]).status, 2)
  const mismatch = f.run(["--confidence", "5"])
  assert.equal(mismatch.status, 2)
  assert.match(mismatch.stderr, /does not match the published review/)
  writeFileSync(f.comments, JSON.stringify(f.reviewComment(3)))
  assert.match(f.run(["--confidence", "4"]).stderr, /does not match/)
  assert.ok(f.calls().every(call => call.gh))
})

test("stamp requires a published review of the current range", t => {
  const f = fixture(t)
  writeFileSync(f.comments, "[]")
  const missing = f.run(["--dry-run"])
  assert.equal(missing.status, 2)
  assert.equal(JSON.parse(missing.stderr).error.code, "publish_required")
  writeFileSync(f.comments, JSON.stringify(f.reviewComment(4, f.base)))
  assert.equal(JSON.parse(f.run().stderr).error.code, "publish_required")
  writeFileSync(f.comments, JSON.stringify([...f.reviewComment(), ...f.reviewComment()]))
  assert.equal(JSON.parse(f.run().stderr).error.code, "publish_required")
  writeFileSync(f.comments, JSON.stringify(f.reviewComment().map(comment => ({ ...comment, user: { id: 2 } }))))
  assert.equal(JSON.parse(f.run().stderr).error.code, "publish_required")
  assert.ok(f.calls().every(call => call.gh))
})

test("stamp reports a service refusal as definite rather than uncertain", t => {
  const f = fixture(t)
  const refused = f.run([], { STAMP_TEST_REFUSAL: "1" })
  assert.equal(refused.status, 2)
  const error = JSON.parse(refused.stderr).error
  assert.equal(error.code, "stamp_refused")
  assert.match(error.message, /protected_path/)
  assert.doesNotMatch(error.message, /may have reached GitHub/)
})
