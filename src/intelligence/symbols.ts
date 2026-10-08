import Parser from "tree-sitter"
import JavaScript from "tree-sitter-javascript"
import TypeScript from "tree-sitter-typescript"
import { CodeSymbol, type SymbolKind } from "../domain/Model.js"

export type LanguageName = "typescript" | "tsx" | "javascript"

export interface ParsedSymbol {
  readonly symbol: CodeSymbol
  readonly calleeNames: ReadonlyArray<string>
}

const symbolTypes = [
  "function_declaration",
  "method_definition",
  "class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "lexical_declaration"
] as const

const kindFor = (type: string): SymbolKind | undefined => {
  switch (type) {
    case "function_declaration":
      return "function"
    case "method_definition":
      return "method"
    case "class_declaration":
      return "class"
    case "interface_declaration":
      return "interface"
    case "type_alias_declaration":
      return "type"
    case "enum_declaration":
      return "enum"
    default:
      return undefined
  }
}

export const languageForPath = (path: string): LanguageName | undefined => {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return "tsx"
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return "typescript"
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "javascript"
  return undefined
}

const codeExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".cs",
  ".scala",
  ".swift"
])

export const isCodePath = (path: string): boolean => {
  const slash = path.lastIndexOf("/")
  const name = slash === -1 ? path : path.slice(slash + 1)
  const dot = name.lastIndexOf(".")
  if (dot === -1) return false
  return codeExtensions.has(name.slice(dot))
}

const parsers: Record<LanguageName, Parser> = {
  typescript: new Parser(),
  tsx: new Parser(),
  javascript: new Parser()
}
parsers.typescript.setLanguage(TypeScript.typescript)
parsers.tsx.setLanguage(TypeScript.tsx)
parsers.javascript.setLanguage(JavaScript)

const lineOf = (node: Parser.SyntaxNode): number => node.startPosition.row + 1
const endLineOf = (node: Parser.SyntaxNode): number => node.endPosition.row + 1

const calleeName = (node: Parser.SyntaxNode): string | undefined => {
  if (node.type === "identifier") return node.text
  if (node.type === "member_expression") {
    const property = node.childForFieldName("property")
    return property?.text
  }
  return undefined
}

const calleesOf = (node: Parser.SyntaxNode): ReadonlyArray<string> => {
  const names = new Set<string>()
  for (const call of node.descendantsOfType("call_expression")) {
    const fn = call.childForFieldName("function")
    if (fn === null) continue
    const name = calleeName(fn)
    if (name !== undefined && name.length > 0) names.add(name)
  }
  return [...names]
}

const signatureOf = (node: Parser.SyntaxNode): string => {
  const line = node.text.split("\n")[0]?.trim() ?? node.type
  return line.length <= 160 ? line : `${line.slice(0, 157)}...`
}

const fromDeclaration = (
  path: string,
  node: Parser.SyntaxNode,
  kind: SymbolKind,
  name: string
): ParsedSymbol | undefined => {
  if (name.length === 0) return undefined
  const startLine = lineOf(node)
  const endLine = Math.max(startLine, endLineOf(node))
  return {
    symbol: new CodeSymbol({
      name,
      kind,
      path,
      startLine,
      endLine,
      signature: signatureOf(node)
    }),
    calleeNames: calleesOf(node)
  }
}

const parseNode = (path: string, node: Parser.SyntaxNode): ParsedSymbol | undefined => {
  if (node.type === "lexical_declaration") {
    const declarator = node.descendantsOfType("variable_declarator")[0]
    if (declarator === undefined) return undefined
    const value = declarator.childForFieldName("value")
    if (value === null || (value.type !== "arrow_function" && value.type !== "function_expression")) {
      return undefined
    }
    const name = declarator.childForFieldName("name")?.text ?? ""
    return fromDeclaration(path, node, "variable", name)
  }
  const kind = kindFor(node.type)
  if (kind === undefined) return undefined
  const name = node.childForFieldName("name")?.text ?? ""
  return fromDeclaration(path, node, kind, name)
}

export const symbolsInSource = (
  path: string,
  source: string,
  language: LanguageName
): ReadonlyArray<ParsedSymbol> => {
  let tree: Parser.Tree
  try {
    tree = parsers[language].parse(source)
  } catch {
    return []
  }
  const found: Array<ParsedSymbol> = []
  for (const node of tree.rootNode.descendantsOfType([...symbolTypes])) {
    const parsed = parseNode(path, node)
    if (parsed !== undefined) found.push(parsed)
  }
  return found
}

export const overlapsTouched = (
  symbol: Pick<CodeSymbol, "startLine" | "endLine">,
  touched: ReadonlySet<number>
): boolean => {
  for (const line of touched) {
    if (line >= symbol.startLine && line <= symbol.endLine) return true
  }
  return false
}

export const changedSymbols = (
  path: string,
  source: string,
  touchedLines: ReadonlyArray<number>
): ReadonlyArray<ParsedSymbol> => {
  const language = languageForPath(path)
  if (language === undefined) return []
  const touched = new Set(touchedLines)
  const parsed = symbolsInSource(path, source, language)
  return parsed.filter((item) => overlapsTouched(item.symbol, touched))
}
