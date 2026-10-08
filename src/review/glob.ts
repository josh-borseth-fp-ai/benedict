/** Convert a repository path glob (`api/**`, `*.ts`) into a full-match regular expression. */
export const matchGlob = (pattern: string, path: string): boolean =>
  globToRegExp(pattern).test(path.replaceAll("\\", "/"))

const globToRegExp = (pattern: string): RegExp => {
  const source = pattern.replaceAll("\\", "/")
  let out = "^"
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    const next = source[i + 1]
    if (char === "*" && next === "*") {
      if (source[i + 2] === "/") {
        out += "(?:.*/)?"
        i += 2
      } else {
        out += ".*"
        i += 1
      }
      continue
    }
    if (char === "*") {
      out += "[^/]*"
      continue
    }
    if (char === "?") {
      out += "[^/]"
      continue
    }
    if (char !== undefined && "\\^$+?.()|[]{}".includes(char)) out += `\\${char}`
    else out += char ?? ""
  }
  out += "$"
  return new RegExp(out)
}
