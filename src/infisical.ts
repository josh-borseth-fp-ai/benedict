import { createPrivateKey } from "node:crypto"
import type { KeyObject } from "node:crypto"
import { Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ReviewError } from "./model.js"

/** ForwardPath's Benedict project. Reading it requires the developer's own `infisical login`. */
export const infisicalProject = { id: "e6fe2297-766e-4958-b082-1e2292d8ea71", environment: "prod" }

export interface AppCredentials {
  readonly appId: string
  readonly privateKey: KeyObject
}

const Secrets = Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String }))
const fail = (message: string) => new ReviewError({ code: "app_credentials", message })

/** Reads the Benedict GitHub App ID and private key from Infisical through its CLI, which owns authentication. */
export const readAppCredentials = Effect.fn("Infisical.readAppCredentials")(function*() {
  const advice = "Install the Infisical CLI, run `infisical login`, and check that you can access the Benedict project."
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const command = ChildProcess.make("infisical", [
    "export", "--projectId", infisicalProject.id, "--env", infisicalProject.environment, "--format", "json", "--silent"
  ], { extendEnv: true, stdin: "ignore" })
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
    Effect.mapError((error) => fail(`Cannot run infisical: ${String(error)}. ${advice}`))
  )
  if (result.exitCode !== 0) return yield* fail(`infisical export failed: ${result.stderr.trim()}. ${advice}`)
  const secrets = yield* Effect.try({ try: () => JSON.parse(result.stdout) as unknown, catch: () => fail(`infisical returned invalid JSON. ${advice}`) }).pipe(
    Effect.flatMap((value) => Schema.decodeUnknownEffect(Secrets)(value).pipe(Effect.mapError(() => fail(`infisical returned unexpected secrets. ${advice}`))))
  )
  const secret = (key: string) => secrets.find((item) => item.key === key)?.value.trim()
  const appId = secret("BENEDICT_APP_ID")
  if (!appId || !/^[1-9]\d*$/.test(appId)) return yield* fail("The Benedict Infisical project must set BENEDICT_APP_ID to the numeric GitHub App ID.")
  const pem = secret("BENEDICT_APP_PRIVATE_KEY")
  if (!pem) return yield* fail("The Benedict Infisical project must set BENEDICT_APP_PRIVATE_KEY to the app's PEM private key.")
  // Secrets pasted on one line often store PEM newlines as \n escapes.
  const privateKey = yield* Effect.try({ try: () => createPrivateKey(pem.replace(/\\n/g, "\n")), catch: () => fail("BENEDICT_APP_PRIVATE_KEY must be the app's PEM private key.") })
  if (privateKey.asymmetricKeyType !== "rsa") return yield* fail("BENEDICT_APP_PRIVATE_KEY must be the app's RSA private key.")
  return { appId, privateKey } satisfies AppCredentials
})
