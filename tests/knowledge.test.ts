import assert from "node:assert/strict"
import { execFile, execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import type { KnowledgeLock, ReviewContext } from "../src/model.js"

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
const manifest = (organization: string, value: Record<string, unknown>) => write(organization, ".benedict/organization.json", json(value))
const commit = (repo: string, message: string) => { git(repo, "add", "."); git(repo, "commit", "--quiet", "-m", message); return git(repo, "rev-parse", "HEAD") }
const init = (repo: string) => {
  mkdirSync(repo, { recursive: true })
  git(repo, "init", "--quiet")
  git(repo, "config", "user.name", "Knowledge Test")
  git(repo, "config", "user.email", "test@example.invalid")
  git(repo, "config", "commit.gpgsign", "false")
}

const fixture = (t: TestContext) => {
  const area = mkdtempSync(join(tmpdir(), "benedict-knowledge-"))
  t.after(() => rmSync(area, { recursive: true, force: true }))
  const repo = join(area, "project")
  const organization = join(area, "engineering-knowledge")
  const home = join(area, "home")
  const cache = join(area, "cache")
  mkdirSync(home)
  init(repo)
  write(repo, "src.ts", "before();\n")
  commit(repo, "base")
  write(repo, "src.ts", "after();\n")
  commit(repo, "head")
  init(organization)
  manifest(organization, {
    defaults: { minimumConfidence: 0.8, rules: ["Org default"] },
    required: { skills: ["security"], minimumConfidence: 0.75, minimumSeverity: "medium", rules: ["Never log credentials."] },
    knowledge: ["knowledge/engineering.md"]
  })
  write(organization, "knowledge/engineering.md", "Use Effect services at system boundaries.\n")
  const revision = commit(organization, "initial approved knowledge")
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    BENEDICT_CACHE_DIR: cache, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", DISABLE_TELEMETRY: "1"
  }
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, env, encoding: "utf8" })
  const context = () => {
    const result = run("context")
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout) as ReviewContext
  }
  const configure = (extra: Record<string, unknown> = {}) => repoConfig(repo, { organization: { source: organization }, ...extra })
  const sync = (...args: string[]) => {
    const result = run("sync", ...args)
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout) as { organization: KnowledgeLock; lockChanged: boolean }
  }
  const lockPath = join(repo, ".benedict/knowledge.lock.json")
  return { area, repo, organization, home, cache, revision, env, run, context, configure, sync, lockPath }
}

test("repo knowledge loads without an organization and text context shows its content", (t) => {
  const { repo, run, context } = fixture(t)
  write(repo, "docs/architecture.md", "Keep domain logic separate from IO.\n")
  repoConfig(repo, { knowledge: ["docs/architecture.md"] })
  assert.deepEqual(context().config.knowledge, [{ scope: "repository", path: "docs/architecture.md", content: "Keep domain logic separate from IO.\n" }])
  assert.match(run("context", "--format", "text").stdout, /Keep domain logic separate from IO/)
})

test("the organization repository can be reviewed with its own repo config", (t) => {
  const { organization, env } = fixture(t)
  repoConfig(organization, { skills: ["correctness"], knowledge: ["knowledge/engineering.md"] })
  write(organization, "knowledge/engineering.md", "Reviewed guidance.\n")
  commit(organization, "review the organization repository")
  const result = spawnSync(process.execPath, [cli, "context"], { cwd: organization, env, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  const context = JSON.parse(result.stdout) as ReviewContext
  assert.deepEqual(context.config.skills, ["correctness"])
  assert.deepEqual(context.files.map((file) => file.path), [".benedict/config.json", "knowledge/engineering.md"])
})

test("sync requires the organization manifest at .benedict/organization.json", (t) => {
  const { organization, configure, run, lockPath } = fixture(t)
  git(organization, "mv", ".benedict/organization.json", "review.json")
  commit(organization, "legacy manifest name")
  configure()
  const result = run("sync")
  assert.equal(result.status, 2)
  assert.match(JSON.parse(result.stderr).error.message, /\.benedict\/organization\.json/)
  assert.equal(existsSync(lockPath), false)
})

test("sync pins organization knowledge and context loads both scopes and policy", (t) => {
  const { repo, configure, revision, sync, context } = fixture(t)
  write(repo, "docs/local.md", "Use this repo's service boundaries.\n")
  configure({ knowledge: ["docs/local.md"], rules: ["Repo override"] })
  assert.equal(sync().organization.revision, revision)
  const result = context()
  assert.equal(result.config.organization?.revision, revision)
  assert.equal(result.config.minimumConfidence, 0.8)
  assert.deepEqual(result.config.rules, ["Repo override", "Never log credentials."])
  assert.deepEqual(result.config.knowledge.map((doc) => doc.scope), ["organization", "repository"])
  assert.deepEqual(result.config.requiredSkills, ["security"])
})

test("review commands require the lock and cache without fetching implicitly", (t) => {
  const { configure, run, sync, cache, organization, context, revision, lockPath } = fixture(t)
  configure()
  let result = run("context")
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stderr).error.code, "knowledge_unavailable")
  assert.equal(existsSync(cache), false)
  sync()
  const locked = readFileSync(lockPath, "utf8")
  renameSync(organization, organization + "-offline")
  assert.equal(context().config.organization?.revision, revision)
  assert.equal(sync().lockChanged, false)
  assert.equal(readFileSync(lockPath, "utf8"), locked)
  rmSync(cache, { recursive: true })
  result = run("context")
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stderr).error.code, "knowledge_unavailable")
  assert.equal(existsSync(cache), false)
})

test("organization changes require --update; normal sync preserves the pin", (t) => {
  const { configure, sync, organization, revision, context, lockPath } = fixture(t)
  configure()
  sync()
  const locked = readFileSync(lockPath, "utf8")
  write(organization, "knowledge/engineering.md", "Updated approved guidance.\n")
  const next = commit(organization, "update knowledge")
  assert.equal(sync().organization.revision, revision)
  assert.equal(readFileSync(lockPath, "utf8"), locked)
  assert.match(context().config.knowledge[0]!.content, /Effect/)
  assert.equal(sync("--update").organization.revision, next)
  assert.equal(context().config.knowledge[0]?.content, "Updated approved guidance.\n")
})

test("a fresh machine restores the exact lock instead of the current branch", (t) => {
  const { configure, sync, cache, organization, revision, context } = fixture(t)
  configure()
  sync()
  write(organization, "knowledge/engineering.md", "Newer guidance.\n")
  commit(organization, "later")
  rmSync(cache, { recursive: true })
  const result = sync()
  assert.equal(result.organization.revision, revision)
  assert.equal(result.lockChanged, false)
  assert.match(context().config.knowledge[0]!.content, /Effect/)
})

test("required lenses survive path narrowing and conflicting repo thresholds fail", (t) => {
  const { configure, sync, context, run, lockPath } = fixture(t)
  configure({ paths: [{ pattern: "*.ts", skills: [] }] })
  sync()
  assert.deepEqual(context().files[0]?.skills, ["security"])
  for (const override of [{ skills: ["correctness"] }, { minimumConfidence: 0.5 }, { minimumSeverity: "low" }]) {
    configure(override)
    const locked = readFileSync(lockPath, "utf8")
    const result = run("context")
    assert.equal(result.status, 2)
    assert.equal(JSON.parse(result.stderr).error.code, "policy_conflict")
    assert.equal(run("sync", "--update").status, 2)
    assert.equal(readFileSync(lockPath, "utf8"), locked)
  }
})

test("check enforces inherited policy and identifies its organization revision", (t) => {
  const { area, configure, sync, run, revision } = fixture(t)
  configure()
  sync()
  const input = join(area, "findings.json")
  writeFileSync(input, JSON.stringify({ findings: [{ file: "src.ts", startLine: 1, endLine: 1,
    severity: "medium", skill: "correctness", title: "Draft", explanation: "An explanation", quote: "after();", confidence: 0.79 }] }))
  const result = run("check", input)
  assert.equal(result.status, 1, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.organization.revision, revision)
  assert.equal(report.rejected[0].reasons[0].code, "below_confidence")
})

test("failed organization updates retain the previous working lock", (t) => {
  const { configure, sync, organization, run, lockPath, context, revision } = fixture(t)
  configure()
  sync()
  const before = readFileSync(lockPath, "utf8")
  manifest(organization, { knowledge: ["../outside.md"] })
  commit(organization, "bad knowledge path")
  const result = run("sync", "--update")
  assert.equal(result.status, 2)
  assert.equal(readFileSync(lockPath, "utf8"), before)
  assert.equal(context().config.organization?.revision, revision)
})

test("local and organization knowledge cannot follow symlinks or traverse paths", (t) => {
  const { repo, organization, configure, run, area } = fixture(t)
  const external = join(area, "private.md")
  writeFileSync(external, "Outside knowledge boundary")
  symlinkSync(external, join(repo, "link.md"))
  repoConfig(repo, { knowledge: ["link.md"] })
  assert.equal(run("context").status, 2)
  repoConfig(repo, { knowledge: ["../private.md"] })
  assert.equal(run("context").status, 2)
  symlinkSync(external, join(organization, "link.md"))
  manifest(organization, { knowledge: ["link.md"] })
  commit(organization, "external link")
  configure()
  assert.equal(run("sync").status, 2)
  assert.equal(existsSync(join(repo, ".benedict/knowledge.lock.json")), false)
})

test("source/ref mismatch, malformed locks and unsupported transports fail closed", (t) => {
  const { repo, configure, sync, run, lockPath, organization } = fixture(t)
  configure()
  sync()
  repoConfig(repo, { organization: { source: organization, ref: "main" } })
  assert.equal(run("context").status, 2)
  assert.equal(run("sync").status, 2)
  configure()
  writeFileSync(lockPath, JSON.stringify({ version: 1, source: organization, ref: "HEAD", revision: "HEAD" }))
  assert.equal(run("context").status, 2)
  rmSync(lockPath)
  for (const source of ["ext::sh -c anything", "https://user:password@example.com/repo.git", "--upload-pack=anything"]) {
    repoConfig(repo, { organization: { source } })
    assert.equal(run("sync").status, 2)
  }
})

test("knowledge cache cannot be placed in the reviewed repo, including through a symlink", (t) => {
  const { repo, area, configure, env } = fixture(t)
  configure()
  const link = join(area, "cache-link")
  symlinkSync(repo, link)
  for (const cache of [join(repo, "cache"), join(link, "cache")]) {
    const result = spawnSync(process.execPath, [cli, "sync"], { cwd: repo, encoding: "utf8", env: { ...env, BENEDICT_CACHE_DIR: cache } })
    assert.equal(result.status, 2)
    assert.equal(JSON.parse(result.stderr).error.code, "knowledge_error")
    assert.equal(existsSync(join(repo, "cache")), false)
  }
})

test("setup connects organization knowledge while preserving existing repo config", (t) => {
  const { repo, run, organization, revision, lockPath, context } = fixture(t)
  repoConfig(repo, { $schema: "https://example.invalid/config.schema.json", minimumConfidence: 0.9 })
  const result = run("setup", "--organization", organization, "--skip-skills")
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(repo, ".benedict/config.json"), "utf8")), {
    $schema: "https://example.invalid/config.schema.json", minimumConfidence: 0.9, organization: { source: organization, ref: "HEAD" }
  })
  assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).revision, revision)
  assert.equal(context().config.minimumConfidence, 0.9)
  const before = readFileSync(lockPath, "utf8")
  assert.equal(run("setup", "--skip-skills").status, 0)
  assert.equal(readFileSync(lockPath, "utf8"), before)
})

test("setup errors preserve config and require explicit non-interactive agent selection", (t) => {
  const { repo, run, lockPath } = fixture(t)
  write(repo, ".benedict/config.json", '{"rules":["Local rule"]}\n')
  const before = readFileSync(join(repo, ".benedict/config.json"), "utf8")
  assert.equal(run("setup", "--organization", "https://user:secret@example.invalid/repo", "--skip-skills").status, 2)
  assert.equal(readFileSync(join(repo, ".benedict/config.json"), "utf8"), before)
  assert.equal(existsSync(lockPath), false)
  assert.equal(run("setup", "--yes").status, 2)
  assert.equal(run("setup", "--global", "--project", "--skip-skills").status, 2)
})

test("setup installs the bundled skill and reference through Vercel into isolated user scope", (t) => {
  const { run, home, repo } = fixture(t)
  const result = run("setup", "--global", "--agent", "claude-code", "--yes")
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const skill = join(home, ".claude/skills/benedict")
  assert.match(readFileSync(join(skill, "SKILL.md"), "utf8"), /name: benedict/)
  assert.equal(readFileSync(join(skill, "references/cli.md"), "utf8"), readFileSync(fileURLToPath(new URL("../.agents/skills/benedict/references/cli.md", import.meta.url)), "utf8"))
  assert.equal(existsSync(join(repo, ".benedict")), false)
  assert.equal(existsSync(join(repo, ".benedict/knowledge.lock.json")), false)
  assert.equal(run("setup", "--agent", "claude-code", "--yes").status, 0)
})

test("setup supports project skill installation and user installation outside Git", (t) => {
  const { run, repo, area, env, home } = fixture(t)
  assert.equal(run("setup", "--project", "--agent", "claude-code", "--yes").status, 0)
  assert.equal(existsSync(join(repo, ".claude/skills/benedict/SKILL.md")), true)
  const result = spawnSync(process.execPath, [cli, "setup", "--agent", "claude-code", "--yes"], { cwd: area, env, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(existsSync(join(home, ".claude/skills/benedict/SKILL.md")), true)
  const invalid = spawnSync(process.execPath, [cli, "setup", "--project", "--yes", "--agent", "claude-code"], { cwd: area, env, encoding: "utf8" })
  assert.equal(invalid.status, 2)
})

test("failed skill installation leaves organization declaration and lock untouched", (t) => {
  const { repo, home, organization, run, lockPath } = fixture(t)
  const config = json({ rules: ["Keep this rule."] })
  write(repo, ".benedict/config.json", config)
  // Block both the canonical directory and the agent's fallback copy target.
  write(home, ".agents/skills", "blocked")
  write(home, ".claude/skills", "blocked")
  const result = run("setup", "--organization", organization, "--agent", "claude-code", "--yes")
  assert.equal(result.status, 2)
  assert.match(result.stderr, /setup_error/)
  assert.equal(readFileSync(join(repo, ".benedict/config.json"), "utf8"), config)
  assert.equal(existsSync(lockPath), false)
})

test("concurrent syncs sharing a cache pin each repository's selected ref", async (t) => {
  const { repo, area, cache, organization, configure, sync, revision, env, lockPath } = fixture(t)
  configure()
  sync()
  git(organization, "branch", "approved", revision)
  write(organization, "knowledge/engineering.md", "Guidance on the other ref.\n")
  const next = commit(organization, "newer guidance")
  git(organization, "branch", "next", next)
  repoConfig(repo, { organization: { source: organization, ref: "approved" } })
  const other = join(area, "other-project")
  init(other)
  repoConfig(other, { organization: { source: organization, ref: "next" } })
  for (const coldCache of [false, true]) {
    if (coldCache) rmSync(cache, { recursive: true })
    await Promise.all([repo, other].map((cwd) => promisify(execFile)(process.execPath, [cli, "sync", "--update"], { cwd, env })))
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).revision, revision)
    assert.equal(JSON.parse(readFileSync(join(other, ".benedict/knowledge.lock.json"), "utf8")).revision, next)
  }
})
