import { Graph, Option } from "effect"
import type { CodeSymbol, Snippet } from "../domain/Model.js"
import type { ParsedSymbol } from "./symbols.js"

export type GraphNode =
  | { readonly _tag: "file"; readonly path: string }
  | {
    readonly _tag: "symbol"
    readonly name: string
    readonly path: string
    readonly kind: string
    readonly startLine: number
  }
  | {
    readonly _tag: "snippet"
    readonly path: string
    readonly line: number
    readonly relation: Snippet["relation"]
  }

export type GraphEdge = "defines" | "calls" | "references" | "tests"

export const symbolKey = (symbol: Pick<CodeSymbol, "path" | "name" | "startLine">): string =>
  `${symbol.path}:${symbol.name}:${symbol.startLine}`

export interface ChangeGraph {
  readonly graph: Graph.DirectedGraph<GraphNode, GraphEdge>
  readonly symbols: ReadonlyMap<string, Graph.NodeIndex>
}

export const buildChangeGraph = (input: {
  readonly files: ReadonlyArray<string>
  readonly symbols: ReadonlyArray<ParsedSymbol>
  readonly snippets: ReadonlyArray<Snippet>
}): ChangeGraph => {
  const symbols = new Map<string, Graph.NodeIndex>()
  const graph = Graph.directed<GraphNode, GraphEdge>((mutable) => {
    const fileNodes = new Map<string, Graph.NodeIndex>()
    const byName = new Map<string, Array<Graph.NodeIndex>>()
    const fileNode = (path: string): Graph.NodeIndex => {
      const existing = fileNodes.get(path)
      if (existing !== undefined) return existing
      const index = Graph.addNode(mutable, { _tag: "file", path })
      fileNodes.set(path, index)
      return index
    }
    for (const file of input.files) fileNode(file)
    for (const parsed of input.symbols) {
      const symbol = parsed.symbol
      const index = Graph.addNode(mutable, {
        _tag: "symbol",
        name: symbol.name,
        path: symbol.path,
        kind: symbol.kind,
        startLine: symbol.startLine
      })
      symbols.set(symbolKey(symbol), index)
      const named = byName.get(symbol.name) ?? []
      named.push(index)
      byName.set(symbol.name, named)
      Graph.addEdge(mutable, fileNode(symbol.path), index, "defines")
    }
    for (const parsed of input.symbols) {
      const from = symbols.get(symbolKey(parsed.symbol))
      if (from === undefined) continue
      for (const callee of parsed.calleeNames) {
        for (const target of byName.get(callee) ?? []) {
          if (target !== from) Graph.addEdge(mutable, from, target, "calls")
        }
      }
    }
    for (const snippet of input.snippets) {
      if (snippet.relation === "definition") continue
      const snippetNode = Graph.addNode(mutable, {
        _tag: "snippet",
        path: snippet.path,
        line: snippet.startLine,
        relation: snippet.relation
      })
      const owner = input.symbols.find((parsed) =>
        parsed.symbol.path === snippet.path &&
        snippet.startLine >= parsed.symbol.startLine &&
        snippet.startLine <= parsed.symbol.endLine
      )
      const explicit = input.symbols.find((parsed) => parsed.symbol.name.length > 0 && snippet.text.includes(parsed.symbol.name))
      const source = owner ?? explicit
      if (source === undefined) continue
      const from = symbols.get(symbolKey(source.symbol))
      if (from === undefined) continue
      const edge: GraphEdge = snippet.relation === "test"
        ? "tests"
        : snippet.relation === "callee"
        ? "calls"
        : "references"
      Graph.addEdge(mutable, from, snippetNode, edge)
    }
  })
  return { graph, symbols }
}

export const summarizeGraph = (change: ChangeGraph): string => {
  const lines: Array<string> = []
  for (const [key, index] of change.symbols) {
    const next = Graph.successors(change.graph, index)
    if (next.length === 0) continue
    const labels = next.flatMap((node) =>
      Option.match(Graph.getNode(change.graph, node), {
        onNone: () => [],
        onSome: (data) => [
          data._tag === "symbol"
            ? `calls ${data.name}`
            : data._tag === "snippet"
            ? `${data.relation} ${data.path}:${data.line}`
            : `file ${data.path}`
        ]
      })
    )
    lines.push(`${key} -> ${labels.join(", ")}`)
  }
  return lines.join("\n")
}
