import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { jsonSchemas } from "../src/json-schema.js"

test("committed editor schemas match the config decoders", () => {
  for (const [name, schema] of Object.entries(jsonSchemas)) {
    const committed: unknown = JSON.parse(readFileSync(new URL(`../schemas/${name}`, import.meta.url), "utf8"))
    assert.deepEqual(committed, schema, `schemas/${name} is stale; run npm run schemas`)
  }
})
