import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import type { ReviewContext } from "../src/model.js"
import { githubRepository } from "../src/pull-request.js"

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url))
const prUrl = "https://github.com/example/project/pull/42"
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }

// Serves fixed PR metadata and records every call.
const fakeGh = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.REVIEW_GH_LOG, JSON.stringify(args)+'\\n');
process.stdout.write(fs.readFileSync(process.env.REVIEW_GH_STATE, 'utf8'));
`

// upstream: main has base → mainline; the PR branches from base and adds a feature commit.
const fixture = (t: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), "review-pr-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim()
  const work = join(root, "work")
  const upstream = join(root, "upstream.git")
  const repo = join(root, "repo")
  const bin = join(root, "bin")
  mkdirSync(work)
  mkdirSync(bin)
  git(work, "init", "--quiet", "--initial-branch", "main")
  git(work, "config", "user.name", "Test")
  git(work, "config", "user.email", "test@example.invalid")
  git(work, "config", "commit.gpgsign", "false")
  const commit = (file: string, source: string) => {
    writeFileSync(join(work, file), source)
    git(work, "add", ".")
    git(work, "commit", "--quiet", "-m", file)
    return git(work, "rev-parse", "HEAD")
  }
  const base = commit("src.ts", "export const value = 1;\n")
  const mainline = commit("main.ts", "export const main = true;\n")
  git(work, "checkout", "--quiet", "-b", "feature", base)
  const feature = commit("src.ts", "export const value = 0;\n")
  git(root, "init", "--quiet", "--bare", upstream)
  git(work, "push", "--quiet", upstream, "main", `feature:refs/pull/42/head`)
  // The local clone has main but not the PR head.
  git(root, "clone", "--quiet", "--no-local", "--branch", "main", upstream, repo)
  git(repo, "remote", "set-url", "origin", "git@github.com:Example/Project.git")
  git(repo, "config", `url.${upstream}.insteadOf`, "git@github.com:Example/Project.git")
  const statePath = join(root, "state.json")
  const logPath = join(root, "calls.jsonl")
  writeFileSync(join(bin, "gh"), fakeGh)
  chmodSync(join(bin, "gh"), 0o755)
  writeFileSync(statePath, JSON.stringify({ state: "open", base: { sha: mainline, ref: "main" }, head: { sha: feature } }))
  const calls = () => existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : []
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "context", ...args], {
    cwd: repo, encoding: "utf8",
    env: { ...env, PATH: `${bin}:${process.env.PATH}`, REVIEW_GH_STATE: statePath, REVIEW_GH_LOG: logPath }
  })
  const context = (...args: string[]) => {
    const result = run(...args)
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout) as ReviewContext
  }
  const failure = (...args: string[]) => {
    const result = run(...args)
    assert.equal(result.status, 2, result.stdout)
    return JSON.parse(result.stderr).error as { code: string; message: string }
  }
  return { repo: repo, git: (...args: string[]) => git(repo, ...args), base, mainline, feature, calls, context, failure }
}

test("--pr fetches missing commits and reviews the merge base through the PR head without moving local refs", (t) => {
  const f = fixture(t)
  assert.throws(() => f.git("cat-file", "-e", `${f.feature}^{commit}`))
  const refs = f.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads")
  const status = f.git("status", "--porcelain")
  const result = f.context("--pr", prUrl)
  assert.deepEqual(result.range, { base: f.base, head: f.feature, worktree: false })
  assert.deepEqual(result.pullRequest, { url: prUrl })
  assert.deepEqual(result.files.map((file) => file.path), ["src.ts"])
  assert.match(result.files[0]!.patch, /\+export const value = 0;/)
  assert.deepEqual(f.calls(), [["api", "--hostname", "github.com", "--method", "GET", "--header", "Accept: application/vnd.github+json", "repos/example/project/pulls/42"]])
  assert.equal(f.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"), refs)
  assert.equal(f.git("status", "--porcelain"), status)
  assert.ok(!existsSync(join(f.repo, ".git", "FETCH_HEAD")))
})

test("--pr uses local commits without contacting the remote", (t) => {
  const f = fixture(t)
  f.git("fetch", "--quiet", "origin", "refs/pull/42/head")
  f.git("config", "--unset", `url.${join(f.repo, "..", "upstream.git")}.insteadOf`)
  f.git("remote", "set-url", "origin", join(f.repo, "missing.git"))
  assert.equal(f.context("--pr", prUrl).range.head, f.feature)
})

test("--pr reports a missing GitHub remote instead of fetching elsewhere", (t) => {
  const f = fixture(t)
  f.git("remote", "set-url", "origin", "https://github.com/other/project.git")
  const error = f.failure("--pr", prUrl)
  assert.equal(error.code, "range_error")
  assert.match(error.message, /no remote points to github\.com\/example\/project/)
})

test("--pr accepts a narrower base inside the PR and rejects one outside it", (t) => {
  const f = fixture(t)
  assert.equal(f.context("--pr", prUrl, "--base", f.feature).range.base, f.feature)
  for (const base of [f.mainline, "does-not-exist"]) assert.equal(f.failure("--pr", prUrl, "--base", base).code, "range_error")
})

test("--pr cannot be combined with --head or --worktree, and requires a PR URL", (t) => {
  const f = fixture(t)
  assert.equal(f.failure("--pr", prUrl, "--head", "HEAD").code, "range_error")
  assert.equal(f.failure("--pr", prUrl, "--worktree").code, "range_error")
  assert.equal(f.failure("--pr", "example/project#42").code, "input_error")
  assert.deepEqual(f.calls(), [])
})

test("GitHub remote URLs are matched in https, ssh and scp forms", () => {
  for (const url of [
    "https://github.com/Example/Project.git", "https://token@github.com/example/project",
    "git@github.com:example/project.git", "ssh://git@github.com/example/project.git", "ssh://git@github.com:22/example/project/"
  ]) assert.equal(githubRepository(url), "example/project", url)
  for (const url of ["https://gitlab.com/example/project.git", "https://github.com.evil/example/project", "/srv/project.git"]) {
    assert.equal(githubRepository(url), null, url)
  }
})
