import { Cache, Context, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { rgPath } from "@vscode/ripgrep"
import { ToolError } from "../domain/Errors.js"
import { CodeSymbol, Location, Snippet } from "../domain/Model.js"
import { capText } from "../git/parseDiff.js"
import { changedSymbols, symbolsInSource, languageForPath, type ParsedSymbol } from "./symbols.js"
import { makeProcessRunner } from "../process/runProcess.js"

const RgMatch = Schema.Struct({
  type: Schema.Literal("match"),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    lines: Schema.Struct({ text: Schema.String }),
    line_number: Schema.Int
  })
})

const isTestPath = (path: string): boolean =>
  path.includes("/__tests__/") ||
  /\.(test|spec)\.[^.]+$/.test(path) ||
  path.includes("/test/")

const snippetAround = (source: string, line: number, relation: Snippet["relation"], path: string): Snippet => {
  const rows = source.split("\n")
  const start = Math.max(1, line - 2)
  const end = Math.min(rows.length, line + 8)
  const text = rows.slice(start - 1, end).join("\n")
  return new Snippet({
    path,
    startLine: start,
    endLine: Math.max(start, end),
    relation,
    text: capText(text, 1200)
  })
}

export class CodeRetriever extends Context.Service<CodeRetriever, {
  readonly getFile: (root: string, path: string, range?: { readonly start: number; readonly end: number }) => Effect.Effect<string, ToolError>
  readonly search: (root: string, query: string) => Effect.Effect<ReadonlyArray<Location>, ToolError>
  readonly findSymbol: (root: string, name: string) => Effect.Effect<ReadonlyArray<CodeSymbol>, ToolError>
  readonly findReferences: (root: string, symbol: CodeSymbol) => Effect.Effect<ReadonlyArray<Location>, ToolError>
  readonly findCallers: (root: string, symbol: CodeSymbol) => Effect.Effect<ReadonlyArray<CodeSymbol>, ToolError>
  readonly findCallees: (root: string, symbol: CodeSymbol) => Effect.Effect<ReadonlyArray<string>, ToolError>
  readonly getTestsFor: (root: string, symbol: CodeSymbol) => Effect.Effect<ReadonlyArray<Location>, ToolError>
  readonly getRelatedCode: (root: string, symbol: CodeSymbol) => Effect.Effect<ReadonlyArray<Snippet>, ToolError>
  readonly changedSymbols: (
    root: string,
    path: string,
    touchedLines: ReadonlyArray<number>
  ) => Effect.Effect<ReadonlyArray<ParsedSymbol>, ToolError>
}>()("review-runtime/CodeRetriever") {
  static readonly layer = Layer.effect(
    CodeRetriever,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const run = yield* makeProcessRunner()
      const files = yield* Cache.make({
        capacity: 200,
        lookup: (absolute: string) => fs.readFileString(absolute)
      })

      const readAbsolute = Effect.fn("CodeRetriever.readAbsolute")(function*(absolute: string) {
        return yield* Cache.get(files, absolute).pipe(
          Effect.mapError((cause) => new ToolError({
            message: `Could not read ${absolute}`,
            detail: cause instanceof Error ? cause.message : String(cause)
          }))
        )
      })

      const getFile = Effect.fn("CodeRetriever.getFile")(function*(
        root: string,
        path: string,
        range?: { readonly start: number; readonly end: number }
      ) {
        const text = yield* readAbsolute(paths.resolve(root, path))
        if (range === undefined) return text
        const rows = text.split("\n")
        const start = Math.max(1, range.start)
        const end = Math.max(start, range.end)
        return rows.slice(start - 1, end).join("\n")
      })

      const search = Effect.fn("CodeRetriever.search")(function*(root: string, query: string) {
        const result = yield* run({
          command: rgPath,
          args: [
            "--json",
            "--fixed-strings",
            "--word-regexp",
            "--max-count",
            "20",
            "--glob",
            "!node_modules/**",
            "--glob",
            "!.git/**",
            "--glob",
            "!dist/**",
            "--glob",
            "!coverage/**",
            "--",
            query,
            "."
          ],
          cwd: root,
          timeoutSeconds: 20
        })
        if (result.exitCode === 1) return []
        if (result.exitCode !== 0) {
          return yield* new ToolError({
            message: `ripgrep failed for ${query}`,
            detail: result.stderr.trim().slice(-1500)
          })
        }
        const locations: Array<Location> = []
        const lines = yield* Stream.fromIterable(result.stdout.split("\n")).pipe(
          Stream.take(200),
          Stream.runCollect
        )
        for (const line of lines) {
          if (line.trim() === "") continue
          const json = yield* Effect.try({
            try: () => JSON.parse(line) as unknown,
            catch: () => new ToolError({ message: "Could not parse ripgrep JSON", detail: line.slice(0, 200) })
          }).pipe(Effect.option)
          if (json._tag === "None") continue
          const decoded = Schema.decodeUnknownResult(RgMatch)(json.value)
          if (decoded._tag !== "Success") continue
          const row = decoded.success
          if (row.data.line_number < 1) continue
          locations.push(new Location({
            path: row.data.path.text,
            line: row.data.line_number,
            text: row.data.lines.text.replace(/\n$/, "")
          }))
          if (locations.length >= 30) break
        }
        return locations
      })

      const findReferences = Effect.fn("CodeRetriever.findReferences")(function*(root: string, symbol: CodeSymbol) {
        const hits = yield* search(root, symbol.name)
        return hits.filter((hit) => !(hit.path === symbol.path && hit.line === symbol.startLine))
      })

      const getTestsFor = Effect.fn("CodeRetriever.getTestsFor")(function*(root: string, symbol: CodeSymbol) {
        const hits = yield* findReferences(root, symbol)
        return hits.filter((hit) => isTestPath(hit.path))
      })

      const findCallees = Effect.fn("CodeRetriever.findCallees")(function*(root: string, symbol: CodeSymbol) {
        const language = languageForPath(symbol.path)
        if (language === undefined) return []
        const source = yield* getFile(root, symbol.path).pipe(Effect.orElseSucceed(() => ""))
        const parsed = symbolsInSource(symbol.path, source, language).find((item) =>
          item.symbol.name === symbol.name && item.symbol.startLine === symbol.startLine
        )
        return parsed?.calleeNames ?? []
      })

      const enclosing = (root: string, hit: Location) =>
        Effect.gen(function*() {
          const language = languageForPath(hit.path)
          if (language === undefined) return undefined
          const source = yield* getFile(root, hit.path).pipe(Effect.option)
          if (source._tag === "None") return undefined
          return symbolsInSource(hit.path, source.value, language).find((item) =>
            hit.line >= item.symbol.startLine && hit.line <= item.symbol.endLine
          )?.symbol
        })

      const findCallers = Effect.fn("CodeRetriever.findCallers")(function*(root: string, symbol: CodeSymbol) {
        const hits = yield* findReferences(root, symbol)
        const callers: Array<CodeSymbol> = []
        const seen = new Set<string>()
        for (const hit of hits) {
          if (isTestPath(hit.path)) continue
          const symbolAtHit = yield* enclosing(root, hit)
          if (symbolAtHit === undefined) continue
          if (symbolAtHit.path === symbol.path && symbolAtHit.startLine === symbol.startLine) continue
          const key = `${symbolAtHit.path}:${symbolAtHit.name}:${symbolAtHit.startLine}`
          if (seen.has(key)) continue
          seen.add(key)
          callers.push(symbolAtHit)
          if (callers.length >= 8) break
        }
        return callers
      })

      const findSymbol = Effect.fn("CodeRetriever.findSymbol")(function*(root: string, name: string) {
        const hits = yield* search(root, name)
        const found: Array<CodeSymbol> = []
        const seen = new Set<string>()
        for (const hit of hits) {
          const language = languageForPath(hit.path)
          if (language === undefined) continue
          const source = yield* getFile(root, hit.path).pipe(Effect.option)
          if (source._tag === "None") continue
          for (const parsed of symbolsInSource(hit.path, source.value, language)) {
            if (parsed.symbol.name !== name) continue
            const key = `${parsed.symbol.path}:${parsed.symbol.startLine}`
            if (seen.has(key)) continue
            seen.add(key)
            found.push(parsed.symbol)
          }
          if (found.length >= 20) break
        }
        return found
      })

      const getRelatedCode = Effect.fn("CodeRetriever.getRelatedCode")(function*(root: string, symbol: CodeSymbol) {
        const definition = yield* getFile(root, symbol.path, {
          start: symbol.startLine,
          end: symbol.endLine
        }).pipe(Effect.orElseSucceed(() => symbol.signature))
        const snippets: Array<Snippet> = [
          new Snippet({
            path: symbol.path,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
            relation: "definition",
            text: capText(definition, 1500)
          })
        ]
        const references = yield* findReferences(root, symbol)
        const callees = yield* findCallees(root, symbol)
        for (const hit of references) {
          if (snippets.length >= 6) break
          const source = yield* getFile(root, hit.path).pipe(Effect.option)
          if (source._tag === "None") continue
          const relation = isTestPath(hit.path) ? "test" : "caller"
          snippets.push(snippetAround(source.value, hit.line, relation, hit.path))
        }
        for (const callee of callees) {
          if (snippets.length >= 8) break
          const matches = yield* findSymbol(root, callee)
          const target = matches[0]
          if (target === undefined) continue
          const source = yield* getFile(root, target.path, {
            start: target.startLine,
            end: target.endLine
          }).pipe(Effect.option)
          if (source._tag === "None") continue
          snippets.push(new Snippet({
            path: target.path,
            startLine: target.startLine,
            endLine: target.endLine,
            relation: "callee",
            text: capText(source.value, 800)
          }))
        }
        return snippets
      })

      const changed = Effect.fn("CodeRetriever.changedSymbols")(function*(
        root: string,
        path: string,
        touchedLines: ReadonlyArray<number>
      ) {
        const source = yield* getFile(root, path).pipe(Effect.orElseSucceed(() => ""))
        return changedSymbols(path, source, touchedLines)
      })

      return CodeRetriever.of({
        getFile,
        search,
        findSymbol,
        findReferences,
        findCallers,
        findCallees,
        getTestsFor,
        getRelatedCode,
        changedSymbols: changed
      })
    })
  )
}
