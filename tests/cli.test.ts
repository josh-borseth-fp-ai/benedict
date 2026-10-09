import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import type { CheckReport, Finding, ReviewContext } from "../src/model.js"

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url))
const git = (repo: string, ...args: string[]) => execFileSync("git", args, {
  cwd: repo,
  encoding: "utf8",
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
}).trim()

const write = (repo: string, path: string, source: string | Uint8Array) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), source)
}

const configure = (repo: string, config: Record<string, unknown>) => write(repo, ".benedict/config.json", JSON.stringify(config, null, 2))

const fixture = (t: TestContext) => {
  const repo = mkdtempSync(join(tmpdir(), "benedict-cli-"))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, "init", "--quiet")
  git(repo, "config", "user.name", "CLI Test")
  git(repo, "config", "user.email", "test@example.invalid")
  git(repo, "config", "commit.gpgsign", "false")
  write(repo, "src.ts", "export const value = 1;\nexport const unchanged = true;\n")
  write(repo, ".gitignore", "ignored.ts\n")
  git(repo, "add", ".")
  git(repo, "commit", "--quiet", "-m", "base")
  const base = git(repo, "rev-parse", "HEAD")
  write(repo, "src.ts", "export const value = 0;\nexport const unchanged = true;\n")
  git(repo, "add", ".")
  git(repo, "commit", "--quiet", "-m", "head")
  const head = git(repo, "rev-parse", "HEAD")
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
  })
  const context = (...args: string[]) => {
    const result = run("context", ...args)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, "")
    return JSON.parse(result.stdout) as ReviewContext
  }
  const check = (findings: ReadonlyArray<unknown>, ...args: string[]) => {
    // Keep generated findings outside the reviewed tree.
    const inputDir = mkdtempSync(join(tmpdir(), "benedict-findings-"))
    t.after(() => rmSync(inputDir, { recursive: true, force: true }))
    const input = join(inputDir, "findings.json")
    writeFileSync(input, JSON.stringify({ findings }))
    const result = run("check", input, ...args)
    assert.equal(result.stderr, "", result.stderr)
    assert.equal(result.status, findings.length === 0 ? 0 : JSON.parse(result.stdout).rejected.length > 0 ? 1 : 0)
    return JSON.parse(result.stdout) as CheckReport
  }
  return { repo, base, head, run, context, check }
}

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  file: "src.ts",
  startLine: 1,
  endLine: 1,
  severity: "medium",
  skill: "correctness",
  title: "Example draft",
  explanation: "An example explanation supplied by the reviewer.",
  quote: "export const value = 0;",
  confidence: 0.8,
  ...overrides
})

test("context resolves immutable commits and provides exact patches and policy", (t) => {
  const { repo, base, head, context } = fixture(t)
  const result = context()
  assert.equal(result.repository, repo)
  assert.deepEqual(result.range, { base, head, worktree: false })
  assert.equal(result.config.minimumSeverity, "medium")
  assert.equal(result.config.minimumConfidence, 0.7)
  assert.equal(result.files.length, 1)
  assert.deepEqual(result.files[0]?.changedLines, [1])
  assert.equal(result.files[0]?.lineCount, 2)
  assert.match(result.files[0]!.patch, /\+export const value = 0;/)
  assert.deepEqual(result.files[0]?.skills, ["correctness", "security"])
})

test("review commands accept stamp configuration without weakening review policy", (t) => {
  const { repo, context, check, run } = fixture(t)
  configure(repo, { skills: ["security"], stamp: { enabled: true, denyPaths: ["infra/**"], maxChangedLines: 100 } })
  assert.deepEqual(context().config.skills, ["security"])
  assert.equal(check([]).summary.accepted, 0)
  for (const stamp of [{ enabled: "yes" }, { maxChangedLines: 0 }, { unknownOption: true }, { service: "https://benedict.example.invalid" }]) {
    configure(repo, { stamp })
    assert.equal(run("context").status, 2)
  }
})

test("evidence is checked against the selected head rather than dirty files", (t) => {
  const { repo, check, head } = fixture(t)
  write(repo, "src.ts", "export const value = 9;\n")
  const status = git(repo, "status", "--porcelain")
  const valid = check([finding()])
  assert.equal(valid.accepted.length, 1)
  assert.equal(valid.range.head, head)
  const invalid = check([finding({ quote: "export const value = 9;" })])
  assert.equal(invalid.rejected[0]?.reasons[0]?.code, "quote_mismatch")
  assert.equal(git(repo, "status", "--porcelain"), status)
})

test("line bounds, evidence location and empty explanations reject independently", (t) => {
  const { check } = fixture(t)
  const report = check([
    finding({ startLine: 2, endLine: 1 }),
    finding({ endLine: 3 }),
    finding({ startLine: 2, endLine: 2 }),
    finding({ startLine: 0 }),
    finding({ explanation: " \t " }),
    finding({ quote: "" }),
    finding({ confidence: 1.1 }),
    finding({ file: "../src.ts" })
  ])
  assert.equal(report.accepted.length, 0)
  assert.deepEqual(report.rejected.map((item) => item.reasons[0]?.code), [
    "invalid_range", "invalid_range", "quote_mismatch", "invalid_finding",
    "invalid_finding", "invalid_finding", "invalid_finding", "outside_diff"
  ])
})

test("thresholds and duplicate selection keep the highest valid confidence", (t) => {
  const { check } = fixture(t)
  const report = check([
    finding({ confidence: 0.7 }),
    finding({ confidence: 0.9 }),
    finding({ confidence: 0.9 }),
    finding({ confidence: 0.99, severity: "low" }),
    finding({ title: "Weak draft", confidence: 0.6 })
  ])
  assert.equal(report.accepted.length, 1)
  assert.equal(report.accepted[0]?.confidence, 0.9)
  assert.deepEqual(report.rejected.map((item) => [item.index, item.reasons[0]?.code]), [
    [0, "duplicate"], [2, "duplicate"], [3, "below_severity"], [4, "below_confidence"]
  ])
})

test("repository policy uses anchored globs, global lens permissions and matching-rule unions", (t) => {
  const { repo, context, check } = fixture(t)
  configure(repo, {
    skills: ["security"],
    minimumSeverity: "high",
    minimumConfidence: 0.85,
    paths: [
      { pattern: "api/**", skills: ["correctness"] },
      { pattern: "api/**", skills: ["security"] },
      { pattern: "*.ts", skills: [] }
    ],
    rules: ["Only report exploitable issues."]
  })
  for (const file of ["api/auth.ts", "web/api/client.ts"]) write(repo, file, "unsafe();\n")
  git(repo, "add", "api", "web")
  git(repo, "commit", "--quiet", "-m", "api files")
  const result = context()
  assert.deepEqual(result.files.find((file) => file.path === "api/auth.ts")?.skills, ["security"])
  assert.deepEqual(result.files.find((file) => file.path === "web/api/client.ts")?.skills, ["security"])
  assert.deepEqual(result.config.rules, ["Only report exploitable issues."])
  const report = check([
    finding({ file: "api/auth.ts", quote: "unsafe();", skill: "correctness", severity: "high", confidence: 0.9 }),
    finding({ file: "api/auth.ts", quote: "unsafe();", skill: "security", severity: "high", confidence: 0.9 }),
    finding({ file: "web/api/client.ts", quote: "unsafe();", skill: "security", severity: "medium", confidence: 0.8 })
  ])
  assert.equal(report.accepted.length, 1)
  assert.equal(report.rejected[0]?.reasons[0]?.code, "skill_not_allowed")
  assert.deepEqual(report.rejected[1]?.reasons.map((reason) => reason.code), ["below_severity", "below_confidence"])
  assert.deepEqual(context("--base", "HEAD~2").files.find((file) => file.path === "src.ts")?.skills, [])
})

test("worktree includes staged, unstaged and untracked changes while respecting ignores", (t) => {
  const { repo, head, context, check } = fixture(t)
  write(repo, "src.ts", "staged();\n")
  git(repo, "add", "src.ts")
  write(repo, "src.ts", "current();\n")
  write(repo, "new.ts", "newCode();\n")
  write(repo, "ignored.ts", "ignored();\n")
  const result = context("--worktree")
  assert.deepEqual(result.range, { base: head, head: null, worktree: true })
  assert.deepEqual(result.files.map((file) => file.path), ["new.ts", "src.ts"])
  assert.equal(result.files[0]?.status, "untracked")
  const report = check([
    finding({ quote: "current();" }),
    finding({ file: "new.ts", quote: "newCode();" }),
    finding({ quote: "staged();", title: "Stale index finding" })
  ], "--worktree")
  assert.equal(report.accepted.length, 2)
  assert.equal(report.rejected[0]?.reasons[0]?.code, "quote_mismatch")
})

test("worktree validates a file recreated after a staged deletion", (t) => {
  const { repo, context, check } = fixture(t)
  git(repo, "rm", "src.ts")
  write(repo, "src.ts", "recreated();\n")
  const result = context("--worktree")
  assert.equal(result.files.filter((file) => file.path === "src.ts").length, 1)
  assert.equal(result.files[0]?.reviewable, true)
  assert.equal(check([finding({ quote: "recreated();" })], "--worktree").accepted.length, 1)
})

test("NUL-delimited diffs preserve unusual names and use literal pathspecs", (t) => {
  const { repo, context, check } = fixture(t)
  const names = ["space tab\tnewline\né.ts", "-leading.ts", ":(glob)*.ts"]
  for (const name of names) write(repo, name, "first();\n")
  git(repo, "add", ".")
  git(repo, "commit", "--quiet", "-m", "unusual files")
  for (const name of names) write(repo, name, "second();\n")
  git(repo, "add", ".")
  git(repo, "commit", "--quiet", "-m", "change unusual files")
  const result = context()
  assert.deepEqual(new Set(result.files.map((file) => file.path)), new Set(names))
  for (const file of result.files) assert.deepEqual(file.changedLines, [1])
  assert.equal(check(names.map((file) => finding({ file, quote: "second();" }))).accepted.length, 3)
})

test("renames retain the destination, old path and reviewed source", (t) => {
  const { repo, context, check } = fixture(t)
  git(repo, "mv", "src.ts", "renamed.ts")
  git(repo, "commit", "--quiet", "-m", "rename")
  const result = context()
  assert.equal(result.files[0]?.path, "renamed.ts")
  assert.equal(result.files[0]?.oldPath, "src.ts")
  assert.equal(result.files[0]?.status, "renamed")
  const report = check([finding({ file: "renamed.ts" }), finding()])
  assert.equal(report.accepted.length, 1)
  assert.equal(report.rejected[0]?.reasons[0]?.code, "outside_diff")
})

test("binary files, deleted files and links cannot validate source evidence", (t) => {
  const { repo, context, check } = fixture(t)
  write(repo, "binary.bin", Uint8Array.from([0, 1, 2, 3]))
  symlinkSync("src.ts", join(repo, "link.ts"))
  git(repo, "rm", "src.ts")
  git(repo, "add", ".")
  git(repo, "commit", "--quiet", "-m", "unsupported files")
  const files = context().files
  assert.equal(files.find((file) => file.path === "binary.bin")?.binary, true)
  assert.equal(files.find((file) => file.path === "src.ts")?.status, "deleted")
  assert.equal(files.find((file) => file.path === "link.ts")?.reviewable, false)
  const report = check([finding({ file: "binary.bin" }), finding(), finding({ file: "link.ts" })])
  assert.deepEqual(report.rejected.map((item) => item.reasons[0]?.code), ["binary_file", "unsupported_file", "unsupported_file"])
})

test("worktree skips link targets outside the repository", (t) => {
  const { repo, context, check } = fixture(t)
  symlinkSync(cli, join(repo, "external.ts"))
  symlinkSync("absent-target.ts", join(repo, "dangling.ts"))
  const result = context("--worktree")
  assert.equal(result.files.find((file) => file.path === "external.ts")?.reviewable, false)
  assert.equal(result.files.find((file) => file.path === "dangling.ts")?.reviewable, false)
  assert.equal(check([finding({ file: "external.ts" })], "--worktree").rejected[0]?.reasons[0]?.code, "unsupported_file")
})

test("config errors fail closed, and --config resolves relative to the repository", (t) => {
  const { repo, run, context } = fixture(t)
  configure(repo, { minimumConfidnce: 0.1 })
  const result = run("context")
  assert.equal(result.status, 2)
  assert.equal(result.stdout, "")
  assert.equal(JSON.parse(result.stderr).error.code, "config_error")
  for (const config of ["skills: [security]\n", '{"skills": ["security"],}', '{"severity": {"minimum": "high"}}', '{"skills": null}']) {
    write(repo, ".benedict/config.json", config)
    assert.equal(run("context").status, 2)
  }
  configure(repo, { skills: ["security"] })
  assert.deepEqual(context().files[0]?.skills, ["security"])
  write(repo, "alternate.json", JSON.stringify({ skills: ["correctness"] }))
  assert.deepEqual(context("--config", "alternate.json").files[0]?.skills, ["correctness"])
  assert.equal(run("context", "--config", "absent.json").status, 2)
  write(repo, "bad.json", JSON.stringify({ paths: [{ pattern: "api/[", skills: ["security"] }] }))
  assert.equal(run("context", "--config", "bad.json").status, 2)
})

test("invalid revisions and conflicting range flags produce actionable errors", (t) => {
  const { run } = fixture(t)
  for (const args of [["--base", "missing-ref"], ["--base=--help"], ["--worktree", "--head", "HEAD"]]) {
    const result = run("context", ...args)
    assert.equal(result.status, 2)
    assert.equal(result.stdout, "")
    assert.equal(JSON.parse(result.stderr).error.code, "range_error")
  }
})

test("empty ranges and empty findings succeed; input failures use exit code 2", (t) => {
  const { repo, context, check, run } = fixture(t)
  assert.equal(context("--base", "HEAD").files.length, 0)
  assert.deepEqual(check([]).summary, { accepted: 0, rejected: 0 })
  const rejected = check([finding()], "--base", "HEAD")
  assert.equal(rejected.rejected[0]?.reasons[0]?.code, "outside_diff")
  write(repo, "malformed.json", "{")
  assert.equal(run("check", "malformed.json").status, 2)
  write(repo, "malformed.json", '{"findings": "wrong"}')
  assert.equal(run("check", "malformed.json").status, 2)
  assert.equal(run("check", "missing.json").status, 2)
  write(repo, "malformed.json", JSON.stringify([finding()]))
  assert.equal(run("check", "malformed.json").status, 0)
})

test("help, version and text reports work through the executable", (t) => {
  const { run, repo } = fixture(t)
  const help = run("--help")
  assert.equal(help.status, 0)
  assert.match(help.stdout, /context/)
  assert.match(help.stdout, /check/)
  assert.equal(run().status, 0)
  assert.match(run("--version").stdout, /0\.1\.0/)
  const text = run("context", "--format", "text")
  assert.equal(text.status, 0)
  assert.match(text.stdout, /correctness, security/)
  write(repo, "findings.json", JSON.stringify({ findings: [finding()] }))
  const report = run("check", "findings.json", "--format", "text")
  assert.equal(report.status, 0)
  assert.match(report.stdout, /Accepted: 1; rejected: 0/)
  assert.match(report.stdout, /Quote:/)
  assert.equal(run("context", "--unknown").status, 2)
})

test("CRLF evidence and final newlines produce correct line bounds", (t) => {
  const { repo, context, check } = fixture(t)
  git(repo, "config", "core.autocrlf", "false")
  write(repo, "src.ts", "first();\r\nsecond();\r\n")
  git(repo, "add", ".")
  git(repo, "commit", "--quiet", "-m", "CRLF")
  assert.equal(context().files[0]?.lineCount, 2)
  const report = check([
    finding({ quote: "first();\nsecond();\n", endLine: 2 }),
    finding({ quote: "second();", startLine: 3, endLine: 3 })
  ])
  assert.equal(report.accepted.length, 1)
  assert.equal(report.rejected[0]?.reasons[0]?.code, "invalid_range")
})

test("repo may point inside a repository and explicit refs override defaults", (t) => {
  const { repo, base, head, context } = fixture(t)
  mkdirSync(join(repo, "nested"))
  const result = context("--repo", resolve(repo, "nested"), "--base", base, "--head", head)
  assert.equal(result.repository, repo)
  assert.deepEqual(result.range, { base, head, worktree: false })
})

test("Git external diff and textconv drivers are disabled", (t) => {
  const { repo, context } = fixture(t)
  const marker = join(repo, "driver-ran")
  const driver = join(repo, "driver.sh")
  writeFileSync(driver, `#!/bin/sh\ntouch '${marker}'\n`)
  chmodSync(driver, 0o755)
  git(repo, "config", "diff.external", driver)
  git(repo, "config", "diff.custom.textconv", driver)
  write(repo, ".gitattributes", "*.ts diff=custom\n")
  const result = context()
  assert.match(result.files[0]!.patch, /export const value/)
  assert.throws(() => readFileSync(marker), /ENOENT/)
})
