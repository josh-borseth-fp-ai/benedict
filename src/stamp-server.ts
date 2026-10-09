import { createServer } from "node:http"
import { createPrivateKey, timingSafeEqual } from "node:crypto"
import { NodeHttpServer } from "@effect/platform-node"
import { ByteSize, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { StampGitHub } from "./stamp-github.js"
import { approveStamp } from "./stamp-service.js"
import { serviceUrl, stampError } from "./stamp-protocol.js"

export interface StampServerConfig {
  readonly service: string
  readonly stampKey: Redacted.Redacted<string>
}
export const readServerConfig = (env: NodeJS.ProcessEnv) => Effect.try({
  try: () => {
    const required = (key: string) => { const value = env[key]; if (!value?.trim()) throw new Error(`Set ${key} before starting the stamp service.`); return value }
    const service = serviceUrl(required("STAMP_PUBLIC_URL"))
    if (!new URL(service).pathname.endsWith("/api/stamp")) throw new Error("STAMP_PUBLIC_URL must be the full HTTPS /api/stamp endpoint.")
    const stampKey = required("STAMP_KEY")
    if (stampKey.length < 32) throw new Error("STAMP_KEY must be at least 32 characters.")
    const appId = required("GITHUB_APP_ID").trim()
    if (!/^[1-9]\d*$/.test(appId)) throw new Error("GITHUB_APP_ID must be the numeric GitHub App ID.")
    // Secret managers often store PEM newlines as \n escapes.
    let privateKey
    try { privateKey = createPrivateKey(required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n")) } catch { throw new Error("GITHUB_APP_PRIVATE_KEY must be the app's PEM private key.") }
    if (privateKey.asymmetricKeyType !== "rsa") throw new Error("GITHUB_APP_PRIVATE_KEY must be the app's RSA private key.")
    return { config: { service, stampKey: Redacted.make(stampKey) }, appId, privateKey }
  }, catch: (error) => stampError("service_config", error instanceof Error ? error.message : "Invalid service configuration.", 500)
})

const authorized = (key: Redacted.Redacted<string>) => Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const input = Buffer.from(request.headers["x-benedict-key"] ?? "")
  const expected = Buffer.from(Redacted.value(key))
  if (input.length !== expected.length || !timingSafeEqual(input, expected)) return yield* stampError("unauthorized", "The key is not authorized for this operation.", 401)
})
const jsonBody = Effect.gen(function*() {
  // Read at most 100 KiB, including requests without a Content-Length header.
  return yield* HttpServerRequest.schemaBodyJson(Schema.Unknown).pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(102_400)),
    Effect.mapError(() => stampError("invalid_request", "Invalid or oversized JSON request.", 400))
  )
})

export const stampRoutes = (config: StampServerConfig) => Layer.mergeAll(
  HttpRouter.add("GET", "/api/health", HttpServerResponse.jsonUnsafe({ status: "ok" })),
  // Preserve the check/write sequence when a client disconnects.
  HttpRouter.add("POST", "/api/stamp", Effect.gen(function*() {
    yield* authorized(config.stampKey)
    const value = yield* Effect.flatMap(jsonBody, body => approveStamp(body, config.service))
    return HttpServerResponse.jsonUnsafe(value, { headers: { "cache-control": "no-store" } })
  }).pipe(Effect.catch(error => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: { code: error.code, message: error.message } }, { status: error.status, headers: { "cache-control": "no-store" } })))), { uninterruptible: true })
)

export const serveStamp = Effect.fn("Stamp.serve")(function*(host: string, port: number) {
  const settings = yield* readServerConfig(process.env)
  const http = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "error" })))
  const github = StampGitHub.layer(settings.appId, settings.privateKey).pipe(Layer.provide(http))
  const server = HttpRouter.serve(stampRoutes(settings.config), { disableLogger: true }).pipe(
    Layer.provide([NodeHttpServer.layer(createServer, { host, port }), github])
  )
  yield* Layer.launch(server)
})
