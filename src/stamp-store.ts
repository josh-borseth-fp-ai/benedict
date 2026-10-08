import { TableClient } from "@azure/data-tables"
import { Context, Effect, Layer } from "effect"
import { stampError } from "./stamp-protocol.js"
import type { StampError, StampResult } from "./stamp-protocol.js"

export interface Reviewer {
  readonly username: string
  readonly id: number
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
}
export interface Enrollment {
  readonly status: "pending" | "polling" | "enrolled"
  readonly deviceCode: string
  readonly expiresAt: number
  readonly nextPollAt: number
  readonly interval: number
  readonly username?: string
}
export interface Reservation {
  readonly status: "pending" | "approved"
  readonly result?: StampResult
}
export class StampStore extends Context.Service<StampStore, {
  readonly users: () => Effect.Effect<ReadonlyArray<Reviewer>, StampError>
  readonly saveUser: (user: Reviewer) => Effect.Effect<void, StampError>
  readonly removeUser: (name: string) => Effect.Effect<void, StampError>
  readonly createEnrollment: (id: string, value: Enrollment) => Effect.Effect<void, StampError>
  readonly enrollment: (id: string) => Effect.Effect<{ readonly value: Enrollment; readonly etag: string }, StampError>
  readonly updateEnrollment: (id: string, value: Enrollment, etag: string) => Effect.Effect<void, StampError>
  readonly reserve: (key: string, head: string) => Effect.Effect<Reservation | null, StampError>
  readonly complete: (key: string, head: string, result: StampResult) => Effect.Effect<void, StampError>
  readonly release: (key: string, head: string) => Effect.Effect<void, StampError>
}>()("review/StampStore") {
  static readonly layer = (connection: string) => Layer.effect(StampStore, Effect.gen(function*() {
    const [users, enrollments, stamps] = yield* Effect.try({
      try: () => ["ReviewUsers", "ReviewEnrollments", "ReviewStamps"].map(name => TableClient.fromConnectionString(connection, name, { retryOptions: { maxRetries: 0 } })) as [TableClient, TableClient, TableClient],
      catch: () => stampError("storage_config", "Invalid stamp storage configuration.", 500)
    })
    const operation = <A>(run: () => Promise<A>) => Effect.tryPromise({
      try: run, catch: (error) => {
        const status = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : 0
        return stampError(status === 412 ? "storage_conflict" : status === 404 ? "not_found" : "storage_error",
          status === 412 ? "Another request updated this enrollment; poll again at the requested interval." : status === 404 ? "The requested enrollment or reviewer was not found." : "Stamp storage operation failed.", status === 404 ? 404 : status === 412 ? 409 : 502)
      }
    })
    yield* Effect.forEach([users, enrollments, stamps], table => operation(() => table.createTable()))
    const partition = (key: string) => key.toLowerCase().replaceAll("/", "~")
    return StampStore.of({
      users: () => operation(async () => {
        const result: Reviewer[] = []
        for await (const entity of users.listEntities<{ payload: string }>({ queryOptions: { filter: "PartitionKey eq 'user'" } })) result.push(JSON.parse(entity.payload) as Reviewer)
        return result
      }),
      saveUser: user => operation(() => users.upsertEntity({ partitionKey: "user", rowKey: user.username.toLowerCase(), payload: JSON.stringify(user) }, "Replace")).pipe(Effect.asVoid),
      removeUser: name => operation(() => users.deleteEntity("user", name.toLowerCase())).pipe(Effect.asVoid),
      createEnrollment: (id, value) => operation(() => enrollments.createEntity({ partitionKey: "enrollment", rowKey: id, payload: JSON.stringify(value) })).pipe(Effect.asVoid),
      enrollment: id => operation(async () => {
        const entity = await enrollments.getEntity<{ payload: string }>("enrollment", id)
        return { value: JSON.parse(entity.payload) as Enrollment, etag: entity.etag! }
      }),
      updateEnrollment: (id, value, etag) => operation(() => enrollments.updateEntity({ partitionKey: "enrollment", rowKey: id, payload: JSON.stringify(value) }, "Replace", { etag })).pipe(Effect.asVoid),
      reserve: (key, head) => operation(async () => {
        try {
          await stamps.createEntity({ partitionKey: partition(key), rowKey: head, payload: JSON.stringify({ status: "pending" }) })
          return null
        } catch (error) {
          if (typeof error !== "object" || error === null || !("statusCode" in error) || error.statusCode !== 409) throw error
          const record = await stamps.getEntity<{ payload: string }>(partition(key), head)
          return JSON.parse(record.payload) as Reservation
        }
      }),
      complete: (key, head, result) => operation(() => stamps.updateEntity({ partitionKey: partition(key), rowKey: head, payload: JSON.stringify({ status: "approved", result }) }, "Replace")).pipe(Effect.asVoid),
      release: (key, head) => operation(() => stamps.deleteEntity(partition(key), head)).pipe(Effect.asVoid)
    })
  }))
}
