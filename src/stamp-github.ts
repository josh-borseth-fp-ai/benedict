import { sign } from "node:crypto"
import type { KeyObject } from "node:crypto"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { stampError } from "./stamp-protocol.js"
import type { StampError } from "./stamp-protocol.js"

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url")

/** An RS256 GitHub App JWT. GitHub accepts at most ten minutes; the clock skew allowance is one minute. */
export const appJwt = (appId: string, privateKey: KeyObject, nowSeconds: number): string => {
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }))}`
  return `${unsigned}.${base64url(sign("sha256", Buffer.from(unsigned), privateKey))}`
}

export interface Installation {
  readonly token: string
  /** The app's bot login, e.g. `review-agent[bot]`. */
  readonly login: string
}

const InstallationInfo = Schema.Struct({ id: Schema.Int, app_slug: Schema.String })
const AccessToken = Schema.Struct({ token: Schema.String })

/** The app private key stays in the service; installation tokens are scoped to one repository per request. */
export class StampGitHub extends Context.Service<StampGitHub, {
  readonly installation: (repository: string) => Effect.Effect<Installation, StampError>
  readonly request: (token: string, method: "GET" | "POST", endpoint: string, body?: unknown) => Effect.Effect<unknown, StampError>
}>()("review/StampGitHub") {
  static readonly layer = (appId: string, privateKey: KeyObject) => Layer.effect(StampGitHub, Effect.gen(function*() {
    const http = yield* HttpClient.HttpClient
    const send = Effect.fn("StampGitHub.send")(function*(token: string, method: "GET" | "POST", endpoint: string, body?: unknown, approval = false) {
      let request = HttpClientRequest.make(method)(`https://api.github.com/${endpoint}`).pipe(HttpClientRequest.setHeaders({
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"
      }))
      if (body !== undefined) request = request.pipe(HttpClientRequest.bodyJsonUnsafe(body))
      const uncertain = () => stampError("write_uncertain", "GitHub approval outcome is uncertain; rerun the stamp to detect an existing approval.", 502)
      const response = yield* http.execute(request).pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(() => approval ? uncertain() : stampError("github_unavailable", "GitHub request failed.", 502))
      )
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 404) return yield* stampError("github_not_found", "GitHub resource not found.", 404)
        if (approval && (response.status === 403 || response.status === 422)) {
          const detail = yield* response.json.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ message: Schema.String }))),
            Effect.map(value => ` GitHub said: ${value.message.slice(0, 200)}`),
            Effect.orElseSucceed(() => "")
          )
          return yield* stampError("review_rejected", `GitHub refused the approval.${detail}`)
        }
        return yield* approval ? uncertain() : stampError("github_unavailable", `GitHub request returned HTTP ${response.status}.`, 502)
      }
      return yield* response.json.pipe(Effect.mapError(() => approval ? uncertain() : stampError("github_unavailable", "GitHub returned an unexpected response.", 502)))
    })
    const decode = <S extends Schema.Top>(schema: S, value: unknown) => Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => stampError("invalid_response", "GitHub returned an unexpected app installation response.", 502))
    )
    return StampGitHub.of({
      installation: Effect.fn("StampGitHub.installation")(function*(repository: string) {
        const jwt = appJwt(appId, privateKey, Math.floor((yield* Clock.currentTimeMillis) / 1000))
        const installation = yield* send(jwt, "GET", `repos/${repository}/installation`).pipe(
          Effect.catchIf(error => error.code === "github_not_found", () => Effect.fail(stampError("repository_disabled", "The Review Agent GitHub App is not installed on this repository.")))
        )
        const info = yield* decode(InstallationInfo, installation)
        const token = yield* decode(AccessToken, yield* send(jwt, "POST", `app/installations/${info.id}/access_tokens`, {
          repositories: [repository.split("/")[1]],
          permissions: { pull_requests: "write", contents: "read" }
        }))
        return { token: token.token, login: `${info.app_slug}[bot]` }
      }),
      request: (token, method, endpoint, body) => send(token, method, endpoint, body, method === "POST")
    })
  }))
}
