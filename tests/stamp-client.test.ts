import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { fileURLToPath } from "node:url"

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url))
const fixture = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), "review-stamp-onboard-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const hook = join(dir, "fetch.mjs"), log = join(dir, "calls.jsonl")
  writeFileSync(log, "")
  writeFileSync(hook, `import fs from 'node:fs';
    globalThis.fetch = async (url, options) => {
      const headers = Object.fromEntries(new Headers(options.headers));
      const body = options.body ? JSON.parse(typeof options.body === 'string' ? options.body : Buffer.from(options.body).toString('utf8')) : undefined;
      const path = new URL(url).pathname;
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({url,headers,body,redirect:options.redirect})+'\\n');
      if (process.env.TEST_FAIL) return new Response('{}',{status:401});
      const result = path.endsWith('/enroll/start') ? {enrollment:'private-poll-capability',userCode:'TEST-CODE',verificationUri:'https://github.com/login/device',expiresIn:15,interval:1} :
        path.endsWith('/enroll/poll') ? {status:'enrolled',username:'reviewer'} :
        path.endsWith('/users/remove') ? {removed:body.username} : {users:[{username:'reviewer',id:2}]};
      return new Response(JSON.stringify(result), {status:200});
    };
  `)
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ["--import", hook, cli, "stamp", ...args], {
    encoding: "utf8", cwd: dir, timeout: 15000,
    env: { ...process.env, REVIEW_STAMP_URL: "https://stamp.example.invalid/api/stamp", REVIEW_STAMP_KEY: "approval-only", REVIEW_STAMP_ENROLL_KEY: "enrollment-only", REVIEW_STAMP_ADMIN_KEY: "admin-only", ...env }
  })
  const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) as Array<{ url: string; headers: Record<string, string>; body?: unknown; redirect: string }>
  return { run, calls }
}

test("built CLI enrolls with explicit consent and displays only the GitHub code and identity", t => {
  const f = fixture(t), result = f.run(["enroll", "--yes"])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { action: "enrolled", username: "reviewer" })
  assert.match(result.stderr, /https:\/\/github.com\/login\/device/)
  assert.match(result.stderr, /TEST-CODE/)
  assert.match(result.stderr, /automated|AI-attributed/)
  for (const secret of ["private-poll-capability", "enrollment-only", "approval-only", "admin-only"]) assert.ok(!(result.stdout + result.stderr).includes(secret))
  assert.equal(f.calls().length, 2)
  assert.deepEqual(f.calls()[0]?.body, { consent: true })
  assert.ok(f.calls().every(call => call.headers["x-review-key"] === "enrollment-only" && call.redirect === "error"))
})

test("built CLI lists and removes reviewers using only the administration key", t => {
  const f = fixture(t)
  const listed = f.run(["users"]), removed = f.run(["remove", "reviewer"])
  assert.equal(listed.status, 0, listed.stderr)
  assert.deepEqual(JSON.parse(listed.stdout), { users: [{ username: "reviewer", id: 2 }] })
  assert.equal(removed.status, 0, removed.stderr)
  assert.deepEqual(JSON.parse(removed.stdout), { removed: "reviewer" })
  assert.ok(f.calls().every(call => call.headers["x-review-key"] === "admin-only"))
})

test("built CLI refuses missing role keys and insecure endpoints and does not retry failures", t => {
  const f = fixture(t)
  assert.equal(f.run(["users"], { REVIEW_STAMP_ADMIN_KEY: "" }).status, 2)
  assert.equal(f.run(["enroll", "--yes"], { REVIEW_STAMP_ENROLL_KEY: "" }).status, 2)
  assert.equal(f.run(["users"], { REVIEW_STAMP_URL: "http://stamp.example.invalid/api/stamp" }).status, 2)
  assert.equal(f.calls().length, 0)
  const refused = f.run(["users"], { TEST_FAIL: "1" })
  assert.equal(refused.status, 2)
  assert.match(refused.stderr, /HTTP 401/)
  assert.equal(f.calls().length, 1)
})
