import { mkdirSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { jsonSchemas } from "../src/json-schema.js"

const directory = fileURLToPath(new URL("../schemas/", import.meta.url))
mkdirSync(directory, { recursive: true })
for (const [name, schema] of Object.entries(jsonSchemas)) writeFileSync(directory + name, JSON.stringify(schema, null, 2) + "\n")
