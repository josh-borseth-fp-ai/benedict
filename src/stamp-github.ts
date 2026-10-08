import { Context, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { stampError } from "./stamp-protocol.js"
import type { StampError } from "./stamp-protocol.js"

/** OAuth and GitHub tokens stay in the shared service; CLI clients receive identity data only. */
export class StampGitHub extends Context.Service<StampGitHub, {
  readonly request: (token: string, method: "GET" | "POST", endpoint: string, body?: unknown) => Effect.Effect<unknown, StampError>
  readonly oauth: (action: "device" | "poll" | "refresh", payload?: Readonly<Record<string, string>>) => Effect.Effect<unknown, StampError>
}>()("review/StampGitHub") {
  static readonly layer = (clientId: string, clientSecret: string) => Layer.effect(StampGitHub, Effect.gen(function*() {
    const http = yield* HttpClient.HttpClient
    const send = Effect.fn("StampGitHub.send")(function*(url: string, method: "GET" | "POST", headers: Record<string, string>, body?: unknown, approval = false) {
      let request = HttpClientRequest.make(method)(url).pipe(HttpClientRequest.setHeaders(headers))
      if (body !== undefined) request = request.pipe(HttpClientRequest.bodyJsonUnsafe(body))
      const response = yield* http.execute(request).pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(() => stampError(approval ? "write_uncertain" : "github_unavailable", approval ? "GitHub approval outcome is uncertain; inspect the PR before retrying." : "GitHub request failed.", 502))
      )
      if (response.status < 200 || response.status >= 300) {
        if (!approval && response.status === 404) return yield* stampError("github_not_found", "GitHub resource not found.", 404)
        if (approval && (response.status === 403 || response.status === 422)) return yield* stampError("review_rejected", "GitHub explicitly refused this reviewer.")
        return yield* stampError(approval ? "write_uncertain" : "github_unavailable", approval ? "GitHub approval outcome is uncertain; inspect the PR before retrying." : "GitHub request was refused.", 502)
      }
      return yield* response.json.pipe(Effect.mapError(() => stampError(approval ? "write_uncertain" : "github_unavailable", "GitHub returned an unexpected response.", 502)))
    })
    return StampGitHub.of({
      request: (token, method, endpoint, body) => send(`https://api.github.com/${endpoint}`, method, {
        Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"
      }, body, method === "POST"),
      oauth: (action, payload = {}) => send(action === "device" ? "https://github.com/login/device/code" : "https://github.com/login/oauth/access_token", "POST", { Accept: "application/json" }, {
        client_id: clientId, ...payload,
        ...(action === "refresh" ? { client_secret: clientSecret, grant_type: "refresh_token" } : {})
      })
    })
  }))
}
