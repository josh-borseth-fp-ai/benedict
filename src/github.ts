import { Context, Effect, Layer, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ReviewError } from "./model.js"

/** GitHub authentication stays with gh; the review tool never reads credentials. */
export class GitHub extends Context.Service<GitHub, {
  readonly request: (method: "GET" | "POST" | "PATCH", endpoint: string, body?: unknown) => Effect.Effect<unknown, ReviewError>
}>()("review/GitHub") {
  static readonly layer = Layer.effect(GitHub, Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const request = Effect.fn("GitHub.request")(function*(method: "GET" | "POST" | "PATCH", endpoint: string, body?: unknown) {
      const writing = method !== "GET"
      const advice = writing
        ? "The write may have reached GitHub. Inspect the PR comment before retrying; writes are not automatically retried."
        : "Check that gh is installed, signed in to github.com, and can access the PR."
      const command = ChildProcess.make("gh", [
        "api", "--hostname", "github.com", "--method", method,
        "--header", "Accept: application/vnd.github+json", endpoint,
        ...(body === undefined ? [] : ["--input", "-"])
      ], {
        env: { GH_PROMPT_DISABLED: "1", GH_DEBUG: "", GH_PAGER: "cat" },
        extendEnv: true,
        stdin: body === undefined ? "ignore" : Stream.make(new TextEncoder().encode(JSON.stringify(body)))
      })
      const result = yield* Effect.scoped(Effect.gen(function*() {
        const handle = yield* spawner.spawn(command)
        const [stdout, stderr, exitCode] = yield* Effect.all([
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode
        ], { concurrency: 3 })
        return { stdout, stderr, exitCode: Number(exitCode) }
      })).pipe(
        Effect.timeout("30 seconds"),
        Effect.mapError((error) => new ReviewError({ code: "github_error", message: `Cannot run gh api: ${String(error)}. ${advice}` }))
      )
      if (result.exitCode !== 0) {
        return yield* new ReviewError({ code: "github_error", message: `gh api ${method} failed: ${result.stderr.trim()}. ${advice}` })
      }
      return yield* Effect.try({
        try: () => JSON.parse(result.stdout) as unknown,
        catch: () => new ReviewError({ code: "github_error", message: `gh returned invalid JSON. ${advice}` })
      })
    })
    return GitHub.of({ request })
  }))
}
