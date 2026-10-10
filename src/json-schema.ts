import { Schema } from "effect"
import { ConfigFile } from "./model.js"

/** Editor schemas for the committed JSON files; the Effect decoders remain authoritative. */
export const schemaBaseUrl = "https://raw.githubusercontent.com/josh-borseth-fp-ai/benedict/main/schemas"

const document = (name: string, title: string, schema: typeof ConfigFile) => {
  const { schema: root, definitions } = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${schemaBaseUrl}/${name}`,
    title,
    ...root,
    ...(Object.keys(definitions).length > 0 ? { $defs: definitions } : {})
  }
}

export const jsonSchemas = {
  "config.schema.json": document("config.schema.json", "Benedict repository config (.benedict/config.json)", ConfigFile)
}
