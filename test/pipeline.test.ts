import { describe, it } from "@effect/vitest"
import { strict as assert } from "node:assert"
import { Effect, FileSystem, Layer } from "effect"
import { AgentBackend } from "../src/agent/backend.js"
import { AgentResult } from "../src/domain/Model.js"
import { AppLayer } from "../src/layers.js"
import { ReviewOptions } from "../src/options.js"
import { review } from "../src/review/pipeline.js"
import { makeProcessRunner } from "../src/process/runProcess.js"

const FakeAgent = Layer.succeed(AgentBackend, {
  name: "codex" as const,
  run: (request) => {
    if (request.purpose === "judge") {
      return Effect.succeed(new AgentResult({
        backend: "codex",
        text: JSON.stringify({
          judgements: [{
            index: 0,
            accept: true,
            confidence: 0.92,
            reason: "The added function calls trim on a nullable input."
          }]
        })
      }))
    }
    if (request.prompt.includes("security reviewer")) {
      return Effect.succeed(new AgentResult({
        backend: "codex",
        text: JSON.stringify({
          findings: [{
            file: "src/user.ts",
            startLine: 2,
            endLine: 4,
            severity: "low",
            title: "style",
            explanation: "",
            evidence: [],
            confidence: 0.4
          }]
        })
      }))
    }
    return Effect.succeed(new AgentResult({
      backend: "codex",
      text: JSON.stringify({
        findings: [{
          file: "src/user.ts",
          startLine: 2,
          endLine: 4,
          severity: "high",
          title: "trim on null",
          explanation: "input.trim throws when input is null",
          evidence: ["return input.trim()"],
          confidence: 0.9
        }]
      })
    }))
  }
})

describe("pipeline", () => {
  it.effect("reviews the previous commit and keeps the evidenced finding", () =>
    Effect.gen(function*() {
      const run = yield* makeProcessRunner()
      const git = (cwd: string, args: ReadonlyArray<string>) =>
        run({ command: "git", args, cwd, timeoutSeconds: 20 }).pipe(
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.void
              : Effect.die(`git ${args.join(" ")} failed: ${result.stderr}`)
          )
        )
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "review-runtime-" })
      const write = (path: string, text: string) => fs.writeFileString(`${root}/${path}`, text)
      yield* fs.makeDirectory(`${root}/src`)
      yield* git(root, ["init"])
      yield* git(root, ["config", "user.email", "review@example.com"])
      yield* git(root, ["config", "user.name", "Review Runtime"])
      yield* write("src/user.ts", "export const ready = true\n")
      yield* git(root, ["add", "src/user.ts"])
      yield* git(root, ["commit", "-m", "initial"])
      yield* write("src/user.ts", `export const ready = true
export function parseUser(input: string | null): string {
  return input.trim()
}
`)
      yield* git(root, ["add", "src/user.ts"])
      yield* git(root, ["commit", "-m", "add parseUser"])

      const report = yield* review().pipe(
        Effect.provide(FakeAgent),
        Effect.provideService(ReviewOptions, {
          repo: root,
          base: "HEAD~1",
          head: "HEAD",
          worktree: false,
          backend: "codex",
          format: "json",
          minConfidence: 0.7,
          minSeverity: "medium",
          timeoutSeconds: 30
        })
      )

      assert.equal(report.files.includes("src/user.ts"), true)
      assert.equal(report.symbols.some((symbol) => symbol.name === "parseUser"), true)
      assert.equal(report.findings.length, 1)
      assert.equal(report.findings[0]?.title, "trim on null")
      assert.equal(report.findings[0]?.skill, "correctness")
      assert.ok((report.findings[0]?.confidence ?? 0) <= 0.9)
      assert.equal(report.rejected.some((item) => item.reason === "finding has no evidence"), true)
    }).pipe(Effect.provide(AppLayer)))
})
