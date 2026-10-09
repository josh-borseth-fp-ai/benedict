import { sign } from "node:crypto"
import type { KeyObject } from "node:crypto"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { serviceError } from "./app-protocol.js"
import type { ServiceError } from "./app-protocol.js"

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url")

/** An RS256 GitHub App JWT. GitHub accepts at most ten minutes; the clock skew allowance is one minute. */
export const appJwt = (appId: string, privateKey: KeyObject, nowSeconds: number): string => {
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }))}`
  return `${unsigned}.${base64url(sign("sha256", Buffer.from(unsigned), privateKey))}`
}

export interface Installation {
  readonly token: string
  /** The app's bot login, e.g. `benedict[bot]`. */
  readonly login: string
}

type Method = "GET" | "POST" | "PATCH"
const InstallationInfo = Schema.Struct({ id: Schema.Int, app_slug: Schema.String })
const AccessToken = Schema.Struct({ token: Schema.String })

/** The app private key stays in the service; installation tokens are scoped to one repository per request. */
export class AppGitHub extends Context.Service<AppGitHub, {
  readonly installation: (repository: string) => Effect.Effect<Installation, ServiceError>
  readonly request: (token: string, method: Method, endpoint: string, body?: unknown) => Effect.Effect<unknown, ServiceError>
}>()("benedict/AppGitHub") {
  static readonly layer = (appId: string, privateKey: KeyObject) => Layer.effect(AppGitHub, Effect.gen(function*() {
    const http = yield* HttpClient.HttpClient
    const send = Effect.fn("AppGitHub.send")(function*(token: string, method: Method, endpoint: string, body?: unknown, write = false) {
      let request = HttpClientRequest.make(method)(`https://api.github.com/${endpoint}`).pipe(HttpClientRequest.setHeaders({
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"
      }))
      if (body !== undefined) request = request.pipe(HttpClientRequest.bodyJsonUnsafe(body))
      const uncertain = () => serviceError("write_uncertain", "The GitHub write outcome is uncertain; rerun the same request to detect a write that landed.", 502)
      const response = yield* http.execute(request).pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(() => write ? uncertain() : serviceError("github_unavailable", "GitHub request failed.", 502))
      )
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 404) return yield* serviceError("github_not_found", "GitHub resource not found.", 404)
        if (write && (response.status === 403 || response.status === 422)) {
          const detail = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ message: Schema.String }))),
            Effect.map(value => ` GitHub said: ${value.message.slice(0, 200)}`),
            Effect.orElseSucceed(() => "")
          )
          return yield* serviceError("write_rejected", `GitHub refused the write.${detail}`)
        }
        return yield* write ? uncertain() : serviceError("github_unavailable", `GitHub request returned HTTP ${response.status}.`, 502)
      }
      return yield* response.json.pipe(Effect.mapError(() => write ? uncertain() : serviceError("github_unavailable", "GitHub returned an unexpected response.", 502)))
    })
    const decode = <S extends Schema.Top>(schema: S, value: unknown) => Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => serviceError("invalid_response", "GitHub returned an unexpected app installation response.", 502))
    )
    return AppGitHub.of({
      installation: Effect.fn("AppGitHub.installation")(function*(repository: string) {
        const jwt = appJwt(appId, privateKey, Math.floor((yield* Clock.currentTimeMillis) / 1000))
        const installation = yield* send(jwt, "GET", `repos/${repository}/installation`).pipe(
          Effect.catchIf(error => error.code === "github_not_found", () => Effect.fail(serviceError("repository_disabled", "The Benedict GitHub App is not installed on this repository.")))
        )
        const info = yield* decode(InstallationInfo, installation)
        const token = yield* decode(AccessToken, yield* send(jwt, "POST", `app/installations/${info.id}/access_tokens`, {
          repositories: [repository.split("/")[1]],
          permissions: { pull_requests: "write", contents: "read" }
        }))
        return { token: token.token, login: `${info.app_slug}[bot]` }
      }),
      request: (token, method, endpoint, body) => send(token, method, endpoint, body, method !== "GET")
    })
  }))
}
