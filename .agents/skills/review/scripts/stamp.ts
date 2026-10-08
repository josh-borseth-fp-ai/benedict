#!/usr/bin/env node
// Decide whether the review agent may stamp a PR, and leave the PR comment once it has.
//
//   stamp.ts check   --report <file>   rules only; prints the Teams message to send
//   stamp.ts comment --report <file>   rules again, then comments on the PR as the gh user
//
// Exit 0 when the rules pass, 1 when they refuse, 2 on a tool or input error.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import {
  CONFIG_FILES,
  evaluate,
  parseNumstat,
  parseReport,
  parseStampConfig,
  prComment,
  teamsMessage,
  type PullRequest,
} from "./gate.ts"

const run = (command: string, args: string[], input?: string): string =>
  execFileSync(command, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] })

const tryRun = (command: string, args: string[]): string | undefined => {
  try {
    return run(command, args)
  } catch {
    return undefined
  }
}

/** Fetch one ref from the remote without writing any local refs, and return its commit. */
const fetchCommit = (remote: string, ref: string): string => {
  run("git", ["fetch", "--quiet", "--no-tags", remote, ref])
  return run("git", ["rev-parse", "FETCH_HEAD^{commit}"]).trim()
}

const main = (): number => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { report: { type: "string" }, remote: { type: "string", default: "origin" } },
  })
  const [command] = positionals
  if ((command !== "check" && command !== "comment") || values.report === undefined) {
    process.stderr.write("Usage: stamp.ts <check|comment> --report <file> [--remote origin]\n")
    return 2
  }

  const report = parseReport(readFileSync(values.report, "utf8"))
  const view = JSON.parse(
    run("gh", ["pr", "view", report.pr, "--json", "url,number,state,isDraft,headRefOid,baseRefName,comments"]),
  ) as PullRequest & { comments: { body: string }[] }

  const baseTip = fetchCommit(values.remote, `refs/heads/${view.baseRefName}`)
  fetchCommit(values.remote, `refs/pull/${view.number}/head`)
  const mergeBase = run("git", ["merge-base", baseTip, view.headRefOid]).trim()

  // Read the rules from the base branch, so the PR cannot loosen them.
  const configText = CONFIG_FILES.map((name) => tryRun("git", ["show", `${baseTip}:${name}`])).find(
    (text) => text !== undefined,
  )
  const config = parseStampConfig(configText)
  const files = parseNumstat(run("git", ["diff", "--numstat", "-z", "--no-renames", mergeBase, view.headRefOid]))

  const reasons = evaluate({
    report,
    config,
    pr: view,
    mergeBase,
    files,
    comments: view.comments.map((comment) => comment.body),
  })

  if (reasons.length > 0) {
    process.stdout.write(`${JSON.stringify({ stamp: false, pr: view.url, reasons }, null, 2)}\n`)
    return 1
  }

  if (command === "check") {
    const teams = { team: config.team, channel: config.channel, message: teamsMessage(report, view) }
    process.stdout.write(`${JSON.stringify({ stamp: true, pr: view.url, teams }, null, 2)}\n`)
    return 0
  }

  run("gh", ["pr", "comment", view.url, "--body-file", "-"], prComment(report))
  process.stdout.write(`${JSON.stringify({ stamp: true, pr: view.url, commented: true }, null, 2)}\n`)
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  const stderr = (error as { stderr?: string }).stderr
  process.stderr.write(`${stderr?.trim() || (error instanceof Error ? error.message : String(error))}\n`)
  process.exitCode = 2
}
