import { createServer } from "node:http"
import { createPrivateKey, timingSafeEqual } from "node:crypto"
import { NodeHttpServer } from "@effect/platform-node"
import { ByteSize, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { AppGitHub } from "./app-github.js"
import { publishAsApp } from "./app-service.js"
import { serviceError } from "./app-protocol.js"

export const readServerConfig = (env: NodeJS.ProcessEnv) => Effect.try({
  try: () => {
    const required = (key: string) => { const value = env[key]; if (!value?.trim()) throw new Error(`Set ${key} before starting the Benedict service.`); return value }
    const serviceKey = required("BENEDICT_SERVICE_KEY")
    if (serviceKey.length < 32) throw new Error("BENEDICT_SERVICE_KEY must be at least 32 characters.")
    const appId = required("GITHUB_APP_ID").trim()
    if (!/^[1-9]\d*$/.test(appId)) throw new Error("GITHUB_APP_ID must be the numeric GitHub App ID.")
    // Secret managers often store PEM newlines as \n escapes.
    let privateKey
    try { privateKey = createPrivateKey(required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n")) } catch { throw new Error("GITHUB_APP_PRIVATE_KEY must be the app's PEM private key.") }
    if (privateKey.asymmetricKeyType !== "rsa") throw new Error("GITHUB_APP_PRIVATE_KEY must be the app's RSA private key.")
    return { serviceKey: Redacted.make(serviceKey), appId, privateKey }
  }, catch: (error) => serviceError("service_config", error instanceof Error ? error.message : "Invalid service configuration.", 500)
})

const authorized = (key: Redacted.Redacted<string>) => Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const input = Buffer.from(request.headers["x-benedict-key"] ?? "")
  const expected = Buffer.from(Redacted.value(key))
  if (input.length !== expected.length || !timingSafeEqual(input, expected)) return yield* serviceError("unauthorized", "The key is not authorized for this operation.", 401)
})
const jsonBody = Effect.gen(function*() {
  // Read at most 256 KiB, including requests without a Content-Length header.
  return yield* HttpServerRequest.schemaBodyJson(Schema.Unknown).pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(262_144)),
    Effect.mapError(() => serviceError("invalid_request", "Invalid or oversized JSON request.", 400))
  )
})

export const serviceRoutes = (serviceKey: Redacted.Redacted<string>) => Layer.mergeAll(
  HttpRouter.add("GET", "/api/health", HttpServerResponse.jsonUnsafe({ status: "ok" })),
  // Preserve the check/write sequence when a client disconnects.
  HttpRouter.add("POST", "/api/reviews", Effect.gen(function*() {
    yield* authorized(serviceKey)
    const value = yield* Effect.flatMap(jsonBody, publishAsApp)
    return HttpServerResponse.jsonUnsafe(value, { headers: { "cache-control": "no-store" } })
  }).pipe(Effect.catch(error => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: { code: error.code, message: error.message } }, { status: error.status, headers: { "cache-control": "no-store" } })))), { uninterruptible: true })
)

export const serve = Effect.fn("App.serve")(function*(host: string, port: number) {
  const settings = yield* readServerConfig(process.env)
  const http = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "error" })))
  const github = AppGitHub.layer(settings.appId, settings.privateKey).pipe(Layer.provide(http))
  const server = HttpRouter.serve(serviceRoutes(settings.serviceKey), { disableLogger: true }).pipe(
    Layer.provide([NodeHttpServer.layer(createServer, { host, port }), github])
  )
  yield* Layer.launch(server)
})
