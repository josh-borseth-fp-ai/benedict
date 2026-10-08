import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { fileURLToPath } from "node:url"

const BASE = "a".repeat(40)
const HEAD = "b".repeat(40)
const PR_URL = "https://github.com/acme/upstream/pull/7"
const script = fileURLToPath(new URL("./stamp.ts", import.meta.url))

const fixture = (t: TestContext, options: { fetched?: string; refreshed?: string; multipleConfigs?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "review-stamp-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const report = join(dir, "report.json")
  const log = join(dir, "calls.jsonl")
  writeFileSync(report, JSON.stringify({ version: 1, pr: PR_URL, base: BASE, head: HEAD, findings: [], dropped: 0 }))
  const pr = { url: PR_URL, number: 7, state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main", comments: [] }
  const executable = (name: string, body: string) => {
    const path = join(dir, name)
    writeFileSync(path, `#!${process.execPath}\n${body}`)
    chmodSync(path, 0o755)
  }
  executable("gh", `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(["gh", ...args]) + "\\n");
    if (args[1] === "comment") throw new Error("Unexpected GitHub write");
    const counter = ${JSON.stringify(join(dir, "views"))};
    const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter)) : 0;
    fs.writeFileSync(counter, String(count + 1));
    process.stdout.write(JSON.stringify({ ...${JSON.stringify(pr)}, headRefOid: count > 0 ? ${JSON.stringify(options.refreshed ?? HEAD)} : ${JSON.stringify(HEAD)} }));
  `)
  executable("git", `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(["git", ...args]) + "\\n");
    const fetch = ${JSON.stringify(join(dir, "fetch"))};
    if (args[0] === "fetch") fs.writeFileSync(fetch, args.at(-1).startsWith("refs/heads/") ? ${JSON.stringify(BASE)} : ${JSON.stringify(options.fetched ?? HEAD)});
    else if (args[0] === "rev-parse") process.stdout.write(fs.readFileSync(fetch));
    else if (args[0] === "merge-base") process.stdout.write(${JSON.stringify(BASE)});
    else if (args[0] === "show") {
      if (args[1].endsWith(":review.yaml") || (${JSON.stringify(options.multipleConfigs ?? false)} && args[1].endsWith(":review.json")))
        process.stdout.write("stamp:\\n  enabled: true\\n  team: Engineering\\n  channel: stamp\\n");
      else process.exitCode = 1;
    } else if (args[0] === "diff") process.stdout.write("1\\t0\\tsrc/safe.ts\\0");
    else throw new Error("Unexpected Git command");
  `)
  const run = () => spawnSync(process.execPath, [script, "check", "--report", report], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }
  })
  return { run, calls: () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) }
}

test("stamp check fetches the PR repository even from a fork checkout", (t) => {
  const { run, calls } = fixture(t)
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).stamp, true)
  const fetches = calls().filter((call) => call[1] === "fetch")
  assert.equal(fetches.length, 2)
  assert.ok(fetches.every((call) => call.includes("https://github.com/acme/upstream.git")))
})

test("stamp check refuses a head that changed between metadata and fetch", (t) => {
  const { run } = fixture(t, { fetched: "c".repeat(40) })
  const result = run()
  assert.equal(result.status, 2)
  assert.match(result.stderr, /PR changed while fetching/)
})

test("stamp check refuses a newly updated head even when the fetched ref was old", (t) => {
  const { run } = fixture(t, { refreshed: "c".repeat(40) })
  const result = run()
  assert.equal(result.status, 2)
  assert.match(result.stderr, /PR changed while fetching/)
})

test("stamp check refuses ambiguous base-branch review configurations", (t) => {
  const { run } = fixture(t, { multipleConfigs: true })
  const result = run()
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Multiple review configs/)
})
