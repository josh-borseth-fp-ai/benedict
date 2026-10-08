import { createServer } from "node:http"
import { timingSafeEqual } from "node:crypto"
import { NodeHttpServer } from "@effect/platform-node"
import { ByteSize, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { StampGitHub } from "./stamp-github.js"
import { StampStore } from "./stamp-store.js"
import { approveStamp, beginEnrollment, pollEnrollment } from "./stamp-service.js"
import { serviceUrl, stampError } from "./stamp-protocol.js"
import type { StampError } from "./stamp-protocol.js"

export interface StampServerConfig {
  readonly service: string
  readonly repositories: ReadonlyArray<string>
  readonly stampKey: Redacted.Redacted<string>
  readonly enrollKey: Redacted.Redacted<string>
  readonly adminKey: Redacted.Redacted<string>
}
export const readServerConfig = (env: NodeJS.ProcessEnv) => Effect.try({
  try: () => {
    const required = (key: string) => { const value = env[key]; if (!value?.trim()) throw new Error(`Set ${key} before starting the stamp service.`); return value }
    const service = serviceUrl(required("STAMP_PUBLIC_URL"))
    if (!new URL(service).pathname.endsWith("/api/stamp")) throw new Error("STAMP_PUBLIC_URL must be the full HTTPS /api/stamp endpoint.")
    const repositories = required("STAMP_REPOSITORIES").split(",").map(value => value.trim())
    if (repositories.some(value => !/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(value))) throw new Error("STAMP_REPOSITORIES must contain OWNER/REPO names.")
    const stampKey = required("STAMP_KEY"), enrollKey = required("STAMP_ENROLL_KEY"), adminKey = required("STAMP_ADMIN_KEY")
    if (new Set([stampKey, enrollKey, adminKey]).size !== 3 || [stampKey, enrollKey, adminKey].some(key => key.length < 32)) throw new Error("Configure three distinct service keys of at least 32 characters.")
    return { config: { service, repositories, stampKey: Redacted.make(stampKey), enrollKey: Redacted.make(enrollKey), adminKey: Redacted.make(adminKey) }, connection: required("TABLE_STORAGE_CONNECTION"), clientId: required("GITHUB_APP_CLIENT_ID"), clientSecret: required("GITHUB_APP_CLIENT_SECRET") }
  }, catch: (error) => stampError("service_config", error instanceof Error ? error.message : "Invalid service configuration.", 500)
})

const authorized = (key: Redacted.Redacted<string>) => Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const input = Buffer.from(request.headers["x-review-key"] ?? "")
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
const endpoint = <A, R>(key: Redacted.Redacted<string>, effect: Effect.Effect<A, StampError, R>) => Effect.gen(function*() {
  yield* authorized(key)
  const value = yield* effect
  return HttpServerResponse.jsonUnsafe(value, { headers: { "cache-control": "no-store" } })
}).pipe(Effect.catch(error => Effect.succeed(HttpServerResponse.jsonUnsafe({ error: { code: error.code, message: error.message } }, { status: error.status, headers: { "cache-control": "no-store" } }))))

export const stampRoutes = (config: StampServerConfig) => Layer.mergeAll(
  HttpRouter.add("GET", "/api/health", HttpServerResponse.jsonUnsafe({ status: "ok" })),
  // Preserve the reservation/write sequence when a client disconnects.
  HttpRouter.add("POST", "/api/stamp", endpoint(config.stampKey, Effect.flatMap(jsonBody, value => approveStamp(value, config.repositories, config.service))), { uninterruptible: true }),
  HttpRouter.add("POST", "/api/enroll/start", endpoint(config.enrollKey, Effect.gen(function*() {
    yield* jsonBody.pipe(Effect.flatMap(value => Schema.decodeUnknownEffect(Schema.Struct({ consent: Schema.Literal(true) }))(value)), Effect.mapError(() => stampError("consent_required", "Explicit reviewer consent is required.", 400)))
    return yield* beginEnrollment()
  }))),
  HttpRouter.add("POST", "/api/enroll/poll", endpoint(config.enrollKey, Effect.gen(function*() {
    const input = yield* jsonBody.pipe(Effect.flatMap(value => Schema.decodeUnknownEffect(Schema.Struct({ enrollment: Schema.String }))(value)), Effect.mapError(() => stampError("invalid_enrollment", "Invalid enrollment request.", 400)))
    return yield* pollEnrollment(input.enrollment)
  })), { uninterruptible: true }),
  HttpRouter.add("GET", "/api/users", endpoint(config.adminKey, Effect.gen(function*() {
    const store = yield* StampStore
    return { users: (yield* store.users()).map(user => ({ username: user.username, id: user.id })) }
  }))),
  HttpRouter.add("POST", "/api/users/remove", endpoint(config.adminKey, Effect.gen(function*() {
    const input = yield* jsonBody.pipe(Effect.flatMap(value => Schema.decodeUnknownEffect(Schema.Struct({ username: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]+$/)) }))(value)), Effect.mapError(() => stampError("invalid_user", "Invalid GitHub username.", 400)))
    const store = yield* StampStore
    yield* store.removeUser(input.username)
    return { removed: input.username }
  })))
)

export const serveStamp = Effect.fn("Stamp.serve")(function*(host: string, port: number) {
  const settings = yield* readServerConfig(process.env)
  const http = FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ redirect: "error" })))
  const github = StampGitHub.layer(settings.clientId, settings.clientSecret).pipe(Layer.provide(http))
  const server = HttpRouter.serve(stampRoutes(settings.config), { disableLogger: true }).pipe(
    Layer.provide([NodeHttpServer.layer(createServer, { host, port }), StampStore.layer(settings.connection), github])
  )
  yield* Layer.launch(server)
})
