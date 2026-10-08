import type { CodeSymbol, FileDiff, SkillName, Snippet } from "../domain/Model.js"
import { capText, compactDiff } from "../git/parseDiff.js"

export interface PromptInput {
  readonly skill: SkillName
  readonly instructions: string
  readonly rules: ReadonlyArray<string>
  readonly notes: ReadonlyArray<{ readonly path: string; readonly text: string }>
  readonly files: ReadonlyArray<FileDiff>
  readonly symbols: ReadonlyArray<CodeSymbol>
  readonly snippets: ReadonlyArray<Snippet>
  readonly graph: string
}

const symbolLines = (symbols: ReadonlyArray<CodeSymbol>): string =>
  symbols.length === 0
    ? "No tree-sitter symbols overlapped the diff."
    : symbols.map((symbol) =>
      `${symbol.path}:${symbol.startLine}-${symbol.endLine} ${symbol.kind} ${symbol.name} ${symbol.signature}`
    ).join("\n")

const snippetLines = (snippets: ReadonlyArray<Snippet>): string =>
  snippets.map((snippet) =>
    `### ${snippet.relation} ${snippet.path}:${snippet.startLine}-${snippet.endLine}\n${snippet.text}`
  ).join("\n\n")

export const reviewPrompt = (input: PromptInput): string => capText(`
You are the ${input.skill} reviewer inside a local review runtime.
Investigate the diff and the retrieved context. You may read the repository to verify a suspicion.
Do not edit files. Do not report style, naming, or formatting.
Every finding needs repository evidence: a short quote or a concrete line reference that is present in the diff or the retrieved snippets.
If you are guessing, omit the finding. Confidence is a number from 0 to 1.

${input.instructions}

Rules:
${input.rules.map((rule) => `- ${rule}`).join("\n")}

Project notes:
${input.notes.length === 0 ? "(none)" : input.notes.map((note) => `## ${note.path}\n${note.text}`).join("\n\n")}

Changed symbols:
${symbolLines(input.symbols)}

Related code:
${input.snippets.length === 0 ? "(none)" : snippetLines(input.snippets)}

Repository graph:
${input.graph === "" ? "(no edges)" : input.graph}

Diff:
${compactDiff(input.files, 24_000)}
`.trim(), 48_000)

export const judgePrompt = (input: {
  readonly rules: ReadonlyArray<string>
  readonly findingsJson: string
  readonly evidence: string
}): string => capText(`
You are the review judge. Accept a finding only when the supplied evidence shows a real defect or a meaningful risk.
Reject style comments, speculative comments, and findings whose evidence is not in the packet.
Use the finding index from the list. Confidence is your confidence in the finding, from 0 to 1.

Rules:
${input.rules.map((rule) => `- ${rule}`).join("\n")}

Findings:
${input.findingsJson}

Evidence packet:
${input.evidence}
`.trim(), 48_000)
