import { Duration, Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ToolError } from "../domain/Errors.js"

export interface ProcessInput {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly stdin?: string
  readonly timeoutSeconds: number
}

export interface ProcessOutput {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const detailOf = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.length > 0) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string") {
    return cause.message
  }
  return String(cause)
}

/**
 * Build a process runner that already holds the platform spawner.
 * Returned commands do not ask the caller for platform services, and they
 * never read provider credentials. The child inherits the user environment so
 * an official CLI can use the login it already owns.
 */
export const makeProcessRunner = Effect.fn("Process.makeRunner")(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return Effect.fn("Process.run")(function*(input: ProcessInput) {
    const stdin = input.stdin === undefined
      ? undefined
      : {
        stream: Stream.encodeText(Stream.make(input.stdin)),
        endOnDone: true
      }
    const command = ChildProcess.make(input.command, [...input.args], {
      cwd: input.cwd,
      extendEnv: true,
      ...(stdin === undefined ? {} : { stdin })
    })
    return yield* Effect.scoped(
      Effect.gen(function*() {
        const handle = yield* spawner.spawn(command)
        const [stdout, stderr, exitCode] = yield* Effect.all([
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode
        ], { concurrency: 3 })
        return { stdout, stderr, exitCode: Number(exitCode) } satisfies ProcessOutput
      })
    ).pipe(
      Effect.timeout(Duration.seconds(input.timeoutSeconds)),
      Effect.mapError((cause) =>
        cause._tag === "TimeoutError"
          ? new ToolError({
            message: `${input.command} timed out after ${input.timeoutSeconds}s`,
            detail: ""
          })
          : new ToolError({
            message: `Failed to launch ${input.command}: ${detailOf(cause)}`,
            detail: detailOf(cause)
          })
      )
    )
  })
})
