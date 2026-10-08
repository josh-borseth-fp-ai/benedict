import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { JsonSchema } from "effect"
import { AgentError } from "../domain/Errors.js"
import {
  AgentFindings,
  AgentResult,
  Finding,
  JudgementResult,
  type AgentRequest,
  type BackendName,
  type SkillName
} from "../domain/Model.js"
import { ReviewOptions } from "../options.js"
import { makeProcessRunner } from "../process/runProcess.js"
import { claudeLaunch, codexLaunch } from "./commands.js"

const ClaudeEnvelope = Schema.Struct({
  is_error: Schema.optional(Schema.Boolean),
  result: Schema.optional(Schema.String),
  structured_output: Schema.optional(Schema.Unknown)
})

export const jsonSchemaText = (schema: Schema.Top): string => {
  const document = JsonSchema.toDocumentDraft07(Schema.toJsonSchemaDocument(schema))
  return JSON.stringify({
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07,
    ...document.schema,
    ...(Object.keys(document.definitions).length === 0 ? {} : { definitions: document.definitions })
  })
}

export const extractJson = (text: string): string => {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  const body = fenced?.[1]?.trim() ?? trimmed
  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  if (start === -1 || end < start) return body
  return body.slice(start, end + 1)
}

const parseUnknown = (text: string) =>
  Effect.try({
    try: () => JSON.parse(extractJson(text)) as unknown,
    catch: (cause) => new AgentError({
      kind: "decode",
      message: "Agent did not return JSON",
      detail: cause instanceof Error ? cause.message : text.slice(0, 500)
    })
  })

export const decodeFindings = (text: string) =>
  parseUnknown(text).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(AgentFindings)(value).pipe(
        Effect.mapError((cause) => new AgentError({
          kind: "decode",
          message: "Agent findings did not match the schema",
          detail: String(cause)
        }))
      )
    )
  )

export const decodeJudgement = (text: string) =>
  parseUnknown(text).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(JudgementResult)(value).pipe(
        Effect.mapError((cause) => new AgentError({
          kind: "decode",
          message: "Judge result did not match the schema",
          detail: String(cause)
        }))
      )
    )
  )

const claudeText = (stdout: string) =>
  parseUnknown(stdout).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(ClaudeEnvelope)(value).pipe(
        Effect.mapError((cause) => new AgentError({
          kind: "decode",
          message: "Claude CLI did not return a JSON result",
          detail: String(cause)
        }))
      )
    ),
    Effect.flatMap((envelope) => {
      if (envelope.is_error === true) {
        return Effect.fail(new AgentError({
          kind: "exit",
          message: "Claude CLI returned an error",
          detail: envelope.result ?? ""
        }))
      }
      if (envelope.structured_output !== undefined) {
        return Effect.try({
          try: () => JSON.stringify(envelope.structured_output),
          catch: (cause) => new AgentError({
            kind: "decode",
            message: "Could not encode Claude structured output",
            detail: cause instanceof Error ? cause.message : String(cause)
          })
        })
      }
      return Effect.succeed(envelope.result ?? "")
    })
  )

export class AgentBackend extends Context.Service<AgentBackend, {
  readonly name: BackendName
  readonly run: (request: AgentRequest) => Effect.Effect<AgentResult, AgentError>
}>()("review-runtime/AgentBackend") {}

const toolToAgent = (backend: BackendName, error: { readonly message: string; readonly detail: string }) =>
  new AgentError({
    kind: error.message.includes("timed out") ? "timeout" : "spawn",
    message: error.message,
    detail: error.detail
  })

const nonZero = (command: string, exitCode: number, stderr: string) =>
  new AgentError({
    kind: "exit",
    message: `${command} exited with ${exitCode}`,
    detail: stderr.trim().slice(-2000)
  })

export const codexLayer = Layer.effect(
  AgentBackend,
  Effect.gen(function*() {
    const options = yield* ReviewOptions
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const launchProcess = yield* makeProcessRunner()
    const run = Effect.fn("CodexCli.run")(function*(request: AgentRequest) {
      const schema = request.schemaName === "JudgementResult" ? JudgementResult : AgentFindings
      return yield* Effect.scoped(Effect.gen(function*() {
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "review-runtime-" }).pipe(
          Effect.mapError((cause) => new AgentError({
            kind: "spawn",
            message: "Could not create a temporary directory for the Codex CLI",
            detail: cause instanceof Error ? cause.message : String(cause)
          }))
        )
        const schemaPath = paths.join(directory, "schema.json")
        const outputPath = paths.join(directory, "last.json")
        yield* fs.writeFileString(schemaPath, jsonSchemaText(schema)).pipe(
          Effect.mapError((cause) => new AgentError({
            kind: "spawn",
            message: "Could not write the Codex output schema",
            detail: cause instanceof Error ? cause.message : String(cause)
          }))
        )
        const launch = codexLaunch({
          repo: options.repo,
          schemaPath,
          outputPath,
          prompt: request.prompt
        })
        const result = yield* launchProcess({
          command: launch.command,
          args: launch.args,
          cwd: options.repo,
          stdin: launch.stdin,
          timeoutSeconds: options.timeoutSeconds
        }).pipe(Effect.mapError((error) => toolToAgent("codex", error)))
        if (result.exitCode !== 0) return yield* nonZero("codex", result.exitCode, result.stderr)
        const written = yield* fs.readFileString(outputPath).pipe(Effect.orElseSucceed(() => ""))
        const text = written.trim() === "" ? result.stdout : written
        return new AgentResult({ backend: "codex", text })
      }))
    })
    return AgentBackend.of({ name: "codex" as const, run })
  })
)

export const claudeLayer = Layer.effect(
  AgentBackend,
  Effect.gen(function*() {
    const options = yield* ReviewOptions
    const launchProcess = yield* makeProcessRunner()
    const run = Effect.fn("ClaudeCode.run")(function*(request: AgentRequest) {
      const schema = request.schemaName === "JudgementResult" ? JudgementResult : AgentFindings
      const launch = claudeLaunch({
        schemaJson: jsonSchemaText(schema),
        prompt: request.prompt
      })
      const result = yield* launchProcess({
        command: launch.command,
        args: launch.args,
        cwd: options.repo,
        stdin: launch.stdin,
        timeoutSeconds: options.timeoutSeconds
      }).pipe(Effect.mapError((error) => toolToAgent("claude", error)))
      if (result.exitCode !== 0) return yield* nonZero("claude", result.exitCode, result.stderr)
      const text = yield* claudeText(result.stdout)
      return new AgentResult({ backend: "claude" as const, text })
    })
    return AgentBackend.of({ name: "claude" as const, run })
  })
)

export const stampFinding = (skill: SkillName, raw: AgentFindings["findings"][number]): Finding =>
  new Finding({
    file: raw.file,
    startLine: raw.startLine,
    endLine: raw.endLine,
    severity: raw.severity,
    category: skill,
    title: raw.title,
    explanation: raw.explanation,
    evidence: raw.evidence,
    ...(raw.suggestedFix === undefined ? {} : { suggestedFix: raw.suggestedFix }),
    confidence: raw.confidence,
    skill
  })
