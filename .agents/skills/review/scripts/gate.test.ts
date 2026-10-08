import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  DEFAULT_MAX_CHANGED_LINES,
  evaluate,
  marker,
  matchGlob,
  parseNumstat,
  parseReport,
  parseStampConfig,
  prComment,
  teamsMessage,
  type Facts,
} from "./gate.ts"

const BASE = "a".repeat(40)
const HEAD = "b".repeat(40)
const URL = "https://github.com/acme/app/pull/7"

const report = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, pr: URL, base: BASE, head: HEAD, findings: [], dropped: 2, ...overrides })

const facts = (overrides: Partial<Facts> = {}): Facts => ({
  report: parseReport(report({ skills: ["correctness", "security"] })),
  config: { enabled: true, team: "Engineering", channel: "stamp", denyPaths: [], maxChangedLines: 400 },
  pr: { url: URL, number: 7, state: "OPEN", isDraft: false, headRefOid: HEAD, baseRefName: "main" },
  mergeBase: BASE,
  files: [{ path: "src/user.ts", lines: 12 }],
  comments: [],
  ...overrides,
})

describe("parseReport", () => {
  test("accepts a clean report and defaults skills", () => {
    assert.deepEqual(parseReport(report()).skills, [])
  })

  test("rejects short SHAs", () => {
    assert.throws(() => parseReport(report({ head: "abc1234" })), /head must be a full commit SHA/)
  })

  test("rejects a finding without a severity", () => {
    const finding = { skill: "security", file: "a.ts", startLine: 1, endLine: 2, title: "x", confidence: 0.9 }
    assert.throws(() => parseReport(report({ findings: [finding] })), /findings\[0\]\.severity/)
  })
})

describe("parseStampConfig", () => {
  test("is off when there is no config or no stamp block", () => {
    assert.equal(parseStampConfig(undefined).enabled, false)
    assert.equal(parseStampConfig("skills:\n  - security\n").enabled, false)
  })

  test("reads YAML", () => {
    const config = parseStampConfig(
      "stamp:\n  enabled: true\n  team: Engineering\n  channel: stamp\n  denyPaths:\n    - infra/**\n",
    )
    assert.deepEqual(config, {
      enabled: true,
      team: "Engineering",
      channel: "stamp",
      denyPaths: ["infra/**"],
      maxChangedLines: DEFAULT_MAX_CHANGED_LINES,
    })
  })

  test("reads JSON", () => {
    assert.equal(parseStampConfig('{"stamp": {"enabled": true, "maxChangedLines": 50}}').maxChangedLines, 50)
  })

  test("rejects a string for enabled", () => {
    assert.throws(() => parseStampConfig("stamp:\n  enabled: 'yes'\n"), /enabled must be true or false/)
  })
})

describe("parseNumstat", () => {
  test("sums added and deleted and counts binary files as zero", () => {
    assert.deepEqual(parseNumstat("3\t4\tsrc/a.ts\0-\t-\tlogo.png\0"), [
      { path: "src/a.ts", lines: 7 },
      { path: "logo.png", lines: 0 },
    ])
  })
})

describe("matchGlob", () => {
  test("deny paths honor brace patterns and hidden files like the review CLI", () => {
    const config = { ...facts().config, denyPaths: ["**/*.{yml,yaml}", "**/.secret"] }
    const files = [{ path: ".github/workflows/ci.yml", lines: 1 }, { path: "config/.secret", lines: 1 }]
    assert.equal(evaluate(facts({ config, files })).length, 2)
  })
  test("matches the documented examples", () => {
    assert.equal(matchGlob("api/**", "api/v1/user.ts"), true)
    assert.equal(matchGlob("api/**", "web/api/user.ts"), false)
    assert.equal(matchGlob("*.ts", "src/user.ts"), false)
    assert.equal(matchGlob("**/*.sql", "db/migrations/001.sql"), true)
    assert.equal(matchGlob("review.yaml", "review.yaml"), true)
  })
})

describe("evaluate", () => {
  test("stamps a clean, current, whole-PR review", () => {
    assert.deepEqual(evaluate(facts()), [])
  })

  test("refuses when stamping is off", () => {
    const config = { enabled: false, denyPaths: [], maxChangedLines: 400 }
    assert.match(evaluate(facts({ config })).join("\n"), /Stamping is off/)
  })

  test("refuses without a Teams channel", () => {
    const config = { enabled: true, team: "Engineering", denyPaths: [], maxChangedLines: 400 }
    assert.match(evaluate(facts({ config })).join("\n"), /stamp\.channel/)
  })

  test("refuses a closed or draft PR", () => {
    const pr = { ...facts().pr, state: "MERGED", isDraft: true }
    const reasons = evaluate(facts({ pr }))
    assert.equal(reasons.length, 2)
  })

  test("refuses when new commits landed after the review", () => {
    const pr = { ...facts().pr, headRefOid: "c".repeat(40) }
    assert.match(evaluate(facts({ pr })).join("\n"), /the PR head is ccccccc/)
  })

  test("refuses a review that did not cover the whole PR", () => {
    assert.match(evaluate(facts({ mergeBase: "d".repeat(40) })).join("\n"), /branches from ddddddd/)
  })

  test("refuses when the review reported findings", () => {
    const finding = { severity: "high", skill: "security", file: "a.ts", startLine: 1, endLine: 2, title: "x", confidence: 0.9 }
    const withFinding = parseReport(report({ findings: [finding] }))
    assert.match(evaluate(facts({ report: withFinding })).join("\n"), /1 finding/)
  })

  test("refuses changes to the review rules and to deny paths", () => {
    const config = { ...facts().config, denyPaths: ["infra/**"] }
    const files = [
      { path: "review.yaml", lines: 1 },
      { path: ".agents/skills/review/SKILL.md", lines: 1 },
      { path: "infra/main.bicep", lines: 1 },
    ]
    assert.equal(evaluate(facts({ config, files })).length, 3)
  })

  test("refuses a PR over the line limit", () => {
    const files = [{ path: "src/big.ts", lines: 401 }]
    assert.match(evaluate(facts({ files })).join("\n"), /401 lines/)
  })

  test("refuses a head that was already stamped", () => {
    assert.match(evaluate(facts({ comments: [`hi\n${marker(HEAD)}`] })).join("\n"), /already stamped/)
  })
})

describe("messages", () => {
  test("Teams message starts with the stamp command and names the agent", () => {
    const { report: clean, pr } = facts()
    assert.equal(
      teamsMessage(clean, pr),
      `stamp ${URL} — 🤖 Review Agent: automated review of bbbbbbb, 0 findings (not a manual stamp)`,
    )
  })

  test("PR comment carries the marker for this head", () => {
    const body = prComment(facts().report)
    assert.match(body, /skills: correctness, security/)
    assert.ok(body.endsWith(marker(HEAD)))
  })
})
