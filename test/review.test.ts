import { describe, it } from "@effect/vitest"
import { strict as assert } from "node:assert"
import { Effect } from "effect"
import { claudeLaunch, codexLaunch } from "../src/agent/commands.js"
import { parseUnifiedDiff } from "../src/git/parseDiff.js"
import { changedSymbols } from "../src/intelligence/symbols.js"
import { matchGlob } from "../src/review/glob.js"
import { applyFloor, dedupeFindings, gateFindings, severityRank } from "../src/review/filter.js"
import { Finding } from "../src/domain/Model.js"

const sampleDiff = `diff --git a/src/user.ts b/src/user.ts
index 1111111..2222222 100644
--- a/src/user.ts
+++ b/src/user.ts
@@ -1 +1,4 @@
 export const ready = true
+export function parseUser(input: string | null): string {
+  return input.trim()
+}
`

const finding = (overrides: Partial<ConstructorParameters<typeof Finding>[0]> = {}) =>
  new Finding({
    file: "src/user.ts",
    startLine: 2,
    endLine: 4,
    severity: "high",
    category: "correctness",
    title: "trim on null",
    explanation: "input.trim throws when input is null",
    evidence: ["return input.trim()"],
    confidence: 0.9,
    skill: "correctness",
    ...overrides
  })

describe("diff and symbols", () => {
  it.effect("parses touched lines and the overlapping function", () =>
    Effect.sync(() => {
      const files = parseUnifiedDiff(sampleDiff)
      assert.equal(files.length, 1)
      const file = files[0]
      assert.ok(file)
      assert.equal(file.path, "src/user.ts")
      assert.equal(file.status, "modified")
      assert.deepEqual(file.touchedLines, [1, 2, 3, 4])
      const source = `export const ready = true
export function parseUser(input: string | null): string {
  return input.trim()
}
`
      const symbols = changedSymbols(file.path, source, file.touchedLines)
      assert.equal(symbols.some((item) => item.symbol.name === "parseUser"), true)
      assert.deepEqual(symbols.find((item) => item.symbol.name === "parseUser")?.calleeNames, ["trim"])
    }))
})

describe("policy", () => {
  it.effect("matches repository globs and drops weak findings", () =>
    Effect.sync(() => {
      assert.equal(matchGlob("api/**", "api/v1/user.ts"), true)
      assert.equal(matchGlob("api/**", "web/api/user.ts"), false)
      assert.equal(matchGlob("db/migrations/**", "db/migrations/001.sql"), true)
      assert.equal(matchGlob("*.ts", "src/user.ts"), false)
      assert.equal(severityRank("high") > severityRank("medium"), true)

      const empty = finding({ evidence: [] })
      const gated = gateFindings({
        findings: [finding(), empty],
        knownPaths: new Set(["src/user.ts"])
      })
      assert.equal(gated.kept.length, 1)
      assert.equal(gated.rejected[0]?.reason, "finding has no evidence")

      const low = finding({ confidence: 0.2, title: "maybe" })
      const floored = applyFloor({
        findings: dedupeFindings([finding(), finding({ confidence: 0.4 }), low]),
        minimumSeverity: "medium",
        minimumConfidence: 0.7
      })
      assert.equal(floored.kept.length, 1)
      assert.equal(floored.kept[0]?.confidence, 0.9)
      assert.equal(floored.rejected.length, 1)
    }))
})

describe("official CLI launch", () => {
  it.effect("keeps the prompt on stdin and does not pass credential flags", () =>
    Effect.sync(() => {
      const prompt = "Review this diff. Do not look for API keys."
      const codex = codexLaunch({
        repo: "/work/repo",
        schemaPath: "/tmp/review-runtime/schema.json",
        outputPath: "/tmp/review-runtime/last.json",
        prompt
      })
      assert.equal(codex.command, "codex")
      assert.equal(codex.stdin, prompt)
      assert.deepEqual(codex.args.filter((arg) => arg.startsWith("-")), [
        "--sandbox",
        "--color",
        "-C",
        "--output-schema",
        "--output-last-message",
        "-"
      ])
      assert.equal(codex.args.includes("read-only"), true)
      assert.equal(codex.args.includes(prompt), false)
      assert.equal(codex.args.some((arg) => arg.toLowerCase().includes("api-key")), false)
      assert.equal(codex.args.some((arg) => arg.includes(".codex")), false)

      const claude = claudeLaunch({ schemaJson: "{\"type\":\"object\"}", prompt })
      assert.equal(claude.command, "claude")
      assert.equal(claude.stdin, prompt)
      assert.deepEqual(claude.args.filter((arg) => arg.startsWith("--") || arg === "-p"), [
        "-p",
        "--output-format",
        "--json-schema",
        "--permission-mode",
        "--permission-prompts"
      ])
      assert.equal(claude.args.includes("plan"), true)
      assert.equal(claude.args.includes("none"), true)
      assert.equal(claude.args.includes(prompt), false)
    }))
})
