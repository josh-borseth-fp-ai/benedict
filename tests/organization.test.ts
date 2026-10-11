import assert from "node:assert/strict"
import { execFile, execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { CheckReport, ReviewContext } from "../src/model.js"

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url))
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
}).trim()
const write = (repo: string, file: string, content: string) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  writeFileSync(join(repo, file), content)
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const repoConfig = (repo: string, config: Record<string, unknown>) => write(repo, ".benedict/config.json", json(config))
const skill = (repo: string, name: string, body: string, description = `${name} guidance.`) =>
  write(repo, `.benedict/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
const commit = (repo: string, message: string) => { git(repo, "add", "."); git(repo, "commit", "--quiet", "-m", message); return git(repo, "rev-parse", "HEAD") }
const init = (repo: string) => {
  mkdirSync(repo, { recursive: true })
  git(repo, "init", "--quiet")
  git(repo, "config", "user.name", "Organization Test")
  git(repo, "config", "user.email", "test@example.invalid")
  git(repo, "config", "commit.gpgsign", "false")
}

const fixture = (t: TestContext) => {
  const area = mkdtempSync(join(tmpdir(), "benedict-organization-"))
  t.after(() => rmSync(area, { recursive: true, force: true }))
  const repo = join(area, "project")
  const organization = join(area, "engineering-skills")
  const home = join(area, "home")
  const cache = join(area, "cache")
  mkdirSync(home)
  init(repo)
  write(repo, "src.ts", "before();\n")
  commit(repo, "base")
  init(organization)
  skill(organization, "credentials", "Never log credentials.")
  const revision = commit(organization, "initial approved skills")
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    BENEDICT_CACHE_DIR: cache, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", DISABLE_TELEMETRY: "1"
  }
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: "utf8" })
  // Policy is read from the review's base, so review the uncommitted worktree against the committed policy.
  const context = () => {
    const result = run("context", "--worktree")
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout) as ReviewContext
  }
  const skillBody = (name: string) => {
    const result = run("skill", name, "--base", "HEAD")
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  const failure = (...args: string[]) => {
    const result = run(...args)
    assert.equal(result.status, 2, result.stdout)
    return JSON.parse(result.stderr).error.code as string
  }
  const configure = (extra: Record<string, unknown> = {}) => repoConfig(repo, { organization: { source: organization }, ...extra })
  const connect = () => { configure(); commit(repo, "connect organization") }
  return { area, repo, organization, home, cache, revision, env, run, context, skillBody, failure, configure, connect }
}

test("context fetches organization skills and lists them with the revision", (t) => {
  const { connect, revision, context, skillBody, run } = fixture(t)
  connect()
  const result = context()
  assert.equal(result.organization?.revision, revision)
  assert.deepEqual(result.skills.map((item) => [item.name, item.scope]), [["correctness", "built-in"], ["security", "built-in"], ["credentials", "organization"]])
  assert.equal(skillBody("credentials"), "Never log credentials.\n")
  assert.match(run("context", "--worktree", "--format", "text").stdout, /- credentials \(organization\): credentials guidance\./)
})

test("the organization repository reviews itself with its skills as repository skills", (t) => {
  const { organization, env } = fixture(t)
  const result = spawnSync(process.execPath, [cli, "context", "--worktree"], { cwd: organization, env, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual((JSON.parse(result.stdout) as ReviewContext).skills.at(-1)?.scope, "repository")
})

test("the organization config applies once it is committed at the review's base", (t) => {
  const { repo, configure, context, revision } = fixture(t)
  configure()
  assert.equal(context().organization, null)
  commit(repo, "connect organization")
  assert.equal(context().organization?.revision, revision)
})

test("every review uses the organization's latest default branch", (t) => {
  const { connect, organization, context, skillBody, revision } = fixture(t)
  connect()
  assert.equal(context().organization?.revision, revision)
  skill(organization, "credentials", "Updated guidance.")
  const next = commit(organization, "update skill")
  assert.equal(context().organization?.revision, next)
  assert.equal(skillBody("credentials"), "Updated guidance.\n")
  git(organization, "checkout", "--quiet", "-b", "draft")
  skill(organization, "credentials", "Unmerged draft guidance.")
  commit(organization, "draft on another branch")
  git(organization, "checkout", "--quiet", "-")
  assert.equal(context().organization?.revision, next)
})

test("reviews fail when the organization cannot be fetched, even with a warm cache", (t) => {
  const { connect, organization, context, cache, failure } = fixture(t)
  connect()
  context()
  assert.equal(existsSync(cache), true)
  renameSync(organization, organization + "-offline")
  assert.equal(failure("context", "--worktree"), "organization_unavailable")
  assert.equal(failure("skill", "credentials", "--base", "HEAD"), "organization_unavailable")
})

test("reviews require organization skills", (t) => {
  const { organization, connect, failure } = fixture(t)
  git(organization, "mv", ".benedict/skills", "skills")
  commit(organization, "skills outside .benedict")
  connect()
  assert.equal(failure("context", "--worktree"), "organization_error")
})

test("check accepts organization skills and identifies the organization revision", (t) => {
  const { area, repo, connect, run, revision } = fixture(t)
  connect()
  write(repo, "src.ts", "after();\n")
  const input = join(area, "findings.json")
  writeFileSync(input, JSON.stringify({ findings: [{ file: "src.ts", startLine: 1, endLine: 1,
    severity: "low", skill: "credentials", title: "Draft", explanation: "An explanation", quote: "after();", confidence: 0.3 }] }))
  const result = run("check", input, "--worktree")
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const report = JSON.parse(result.stdout) as CheckReport
  assert.equal(report.organization?.revision, revision)
  assert.equal(report.accepted[0]?.skill, "credentials")
})

test("invalid organization skills fail closed", (t) => {
  const { connect, organization, failure } = fixture(t)
  connect()
  write(organization, ".benedict/skills/broken/SKILL.md", "No frontmatter.\n")
  commit(organization, "bad skill")
  assert.equal(failure("context", "--worktree"), "skill_error")
})

test("repository skills override organization skills, which override built-in skills", (t) => {
  const { repo, connect, organization, context, skillBody } = fixture(t)
  skill(organization, "security", "Organization security rules.", "Organization security.")
  commit(organization, "replace built-in security")
  connect()
  const scopes = () => Object.fromEntries(context().skills.map((item) => [item.name, item.scope]))
  assert.deepEqual(scopes(), { correctness: "built-in", security: "organization", credentials: "organization" })
  assert.match(skillBody("security"), /Organization security rules/)
  skill(repo, "credentials", "Repository credential rules.", "Repository credentials.")
  skill(repo, "security", "Repository security rules.", "Repository security.")
  commit(repo, "replace organization skills")
  assert.deepEqual(scopes(), { correctness: "built-in", security: "repository", credentials: "repository" })
  assert.match(skillBody("credentials"), /Repository credential rules/)
  assert.match(skillBody("security"), /Repository security rules/)
})

test("organization skills cannot be symlinks", (t) => {
  const { organization, connect, failure, area } = fixture(t)
  writeFileSync(join(area, "outside.md"), "---\nname: linked\ndescription: Outside.\n---\n")
  mkdirSync(join(organization, ".benedict/skills/linked"))
  symlinkSync(join(area, "outside.md"), join(organization, ".benedict/skills/linked/SKILL.md"))
  commit(organization, "external link")
  connect()
  assert.equal(failure("context", "--worktree"), "skill_error")
})

test("pinned refs and unsupported transports fail closed", (t) => {
  const { repo, organization, failure } = fixture(t)
  repoConfig(repo, { organization: { source: organization, ref: "main" } })
  commit(repo, "pinned ref")
  assert.equal(failure("context", "--worktree"), "config_error")
  for (const source of ["ext::sh -c anything", "https://user:password@example.com/repo.git", "--upload-pack=anything"]) {
    repoConfig(repo, { organization: { source } })
    commit(repo, `source ${source}`)
    assert.equal(failure("context", "--worktree"), "organization_error")
  }
})

test("the organization cache cannot be placed in the reviewed repo, including through a symlink", (t) => {
  const { repo, area, connect, env } = fixture(t)
  connect()
  const link = join(area, "cache-link")
  symlinkSync(repo, link)
  for (const cache of [join(repo, "cache"), join(link, "cache")]) {
    const result = spawnSync(process.execPath, [cli, "context", "--worktree"], { cwd: repo, encoding: "utf8", env: { ...env, BENEDICT_CACHE_DIR: cache } })
    assert.equal(result.status, 2)
    assert.equal(JSON.parse(result.stderr).error.code, "organization_error")
    assert.equal(existsSync(join(repo, "cache")), false)
  }
})

test("setup connects an organization while preserving the existing config", (t) => {
  const { repo, run, organization, revision, area } = fixture(t)
  repoConfig(repo, { $schema: "https://example.invalid/config.schema.json" })
  const result = run("setup", "--organization", organization, "--skip-skills")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(revision))
  const configFile = join(repo, ".benedict/config.json")
  assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), {
    $schema: "https://example.invalid/config.schema.json", organization: { source: organization }
  })
  assert.equal(existsSync(join(repo, ".benedict/organization.lock.json")), false)
  const before = readFileSync(configFile, "utf8")
  assert.equal(run("setup", "--organization", organization, "--skip-skills").status, 0)
  assert.equal(run("setup", "--skip-skills").status, 0)
  assert.equal(readFileSync(configFile, "utf8"), before)
  const other = join(area, "other-skills")
  init(other)
  skill(other, "other", "Other guidance.")
  commit(other, "other skills")
  assert.equal(run("setup", "--organization", other, "--skip-skills").status, 2)
  assert.equal(readFileSync(configFile, "utf8"), before)
})

test("setup errors preserve config and require explicit non-interactive agent selection", (t) => {
  const { repo, run, organization, area } = fixture(t)
  repoConfig(repo, { $schema: "https://example.invalid/config.schema.json" })
  const before = readFileSync(join(repo, ".benedict/config.json"), "utf8")
  assert.equal(run("setup", "--organization", "https://user:secret@example.invalid/repo", "--skip-skills").status, 2)
  assert.equal(run("setup", "--organization", join(area, "missing"), "--skip-skills").status, 2)
  assert.equal(run("setup", "--organization", organization, "--ref", "main", "--skip-skills").status, 2)
  assert.equal(readFileSync(join(repo, ".benedict/config.json"), "utf8"), before)
  assert.equal(run("setup", "--yes").status, 2)
  assert.equal(run("setup", "--global", "--skip-skills").status, 2)
  assert.equal(run("setup", "--config", "other.json", "--skip-skills").status, 2)
})

test("setup installs the bundled skill and reference into the repository", (t) => {
  const { run, home, repo, area, env } = fixture(t)
  const result = run("setup", "--agent", "claude-code", "--yes")
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const skill = join(repo, ".claude/skills/benedict")
  assert.match(readFileSync(join(skill, "SKILL.md"), "utf8"), /name: benedict/)
  assert.equal(readFileSync(join(skill, "references/cli.md"), "utf8"), readFileSync(fileURLToPath(new URL("../.agents/skills/benedict/references/cli.md", import.meta.url)), "utf8"))
  assert.equal(existsSync(join(home, ".claude/skills/benedict")), false)
  assert.equal(existsSync(join(home, ".agents/skills/benedict")), false)
  assert.equal(run("setup", "--agent", "claude-code", "--yes").status, 0)
  const outside = spawnSync(process.execPath, [cli, "setup", "--agent", "claude-code", "--yes"], { cwd: area, env, encoding: "utf8" })
  assert.equal(outside.status, 2)
  assert.match(outside.stderr, /setup_error/)
})

test("failed skill installation leaves the organization declaration untouched", (t) => {
  const { repo, organization, run } = fixture(t)
  const config = json({ $schema: "https://example.invalid/config.schema.json" })
  write(repo, ".benedict/config.json", config)
  // Block both the canonical directory and the agent's fallback copy target.
  write(repo, ".agents/skills", "blocked")
  write(repo, ".claude/skills", "blocked")
  const result = run("setup", "--organization", organization, "--agent", "claude-code", "--yes")
  assert.equal(result.status, 2)
  assert.match(result.stderr, /setup_error/)
  assert.equal(readFileSync(join(repo, ".benedict/config.json"), "utf8"), config)
})

test("concurrent reviews sharing a cache each fetch the latest skills", async (t) => {
  const { repo, area, cache, organization, connect, env } = fixture(t)
  connect()
  const other = join(area, "other-project")
  init(other)
  repoConfig(other, { organization: { source: organization } })
  commit(other, "connect organization")
  for (const coldCache of [true, false]) {
    if (coldCache) rmSync(cache, { recursive: true, force: true })
    skill(organization, "credentials", `Guidance with a ${coldCache ? "cold" : "warm"} cache.`)
    const next = commit(organization, `update for a ${coldCache ? "cold" : "warm"} cache`)
    const results = await Promise.all([repo, other].map((cwd) => promisify(execFile)(process.execPath, [cli, "context", "--base", "HEAD"], { cwd, env })))
    for (const result of results) assert.equal((JSON.parse(result.stdout) as ReviewContext).organization?.revision, next)
  }
})
