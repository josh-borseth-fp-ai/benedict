import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { stripVTControlCharacters } from "node:util"
import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { parseDocument } from "yaml"
import { readRepositoryConfig } from "./config.js"
import { readLock, readRepositoryKnowledge, resolveOrganization, writeLock } from "./knowledge.js"
import { ReviewError } from "./model.js"
import type { ConfigFile, KnowledgeLock } from "./model.js"
import { resolvePolicy } from "./policy.js"
import { prepareOrganization, repositoryRoot } from "./sync.js"

export interface SetupOptions {
  readonly repo: string
  readonly config?: string
  readonly organization?: string
  readonly ref?: string
  readonly project: boolean
  readonly agents: ReadonlyArray<string>
  readonly yes: boolean
  readonly skipSkills: boolean
}

const bundledSkill = fileURLToPath(new URL("../.agents/skills/review", import.meta.url))
const installer = fileURLToPath(new URL("./bin/cli.mjs", pathToFileURL(createRequire(import.meta.url).resolve("skills/package.json"))))

export const installSkill = Effect.fn("Setup.installSkill")(function*(cwd: string, options: SetupOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const args = [installer, "add", bundledSkill, "--skill", "review",
    ...(options.project ? [] : ["--global"]),
    ...options.agents.flatMap((agent) => ["--agent", agent]),
    ...(options.yes ? ["--yes", "--json"] : [])]
  if (options.yes && options.agents.length === 0) {
    return yield* new ReviewError({ code: "setup_error", message: "For non-interactive setup, select agents with --agent <name> (repeat as needed, or use --agent '*')." })
  }
  const command = ChildProcess.make(process.execPath, args, {
    cwd, stdin: "inherit", stderr: "inherit",
    env: { DISABLE_TELEMETRY: "1" }, extendEnv: true
  })
  const result = yield* Effect.scoped(Effect.gen(function*() {
    const child = yield* spawner.spawn(command)
    const output = Stream.decodeText(child.stdout).pipe(Stream.tap((chunk) => Effect.sync(() => {
      if (!options.yes) process.stdout.write(chunk)
    })))
    const [stdout, exitCode] = yield* Effect.all([Stream.mkString(output), child.exitCode], { concurrency: 2 })
    return { stdout, exitCode: Number(exitCode) }
  })).pipe(Effect.timeout("10 minutes"))
  const installed = options.yes ? yield* Effect.try({
    try: () => {
      const entries: unknown = JSON.parse(result.stdout)
      return Array.isArray(entries) && entries.length > 0 && entries.every((entry) =>
        entry.name === "review" && entry.status === "installed" && Array.isArray(entry.agents) && entry.agents.length > 0)
    },
    catch: () => new ReviewError({ code: "setup_error", message: "The skill installer returned an invalid result. Organization configuration was not changed." })
  }) : !/Installation cancelled|Failed to install/.test(stripVTControlCharacters(result.stdout))
  if (result.exitCode !== 0 || !installed) return yield* new ReviewError({ code: "setup_error", message: `Skill installation failed or was cancelled (exit ${result.exitCode}). Organization configuration was not changed.` })
})

const saveDeclaration = Effect.fn("Setup.saveDeclaration")(function*(root: string, source: string | null, decoded: ConfigFile) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const target = source ?? path.join(root, "review.yaml")
  if (yield* fs.exists(target)) {
    if ((yield* fs.realPath(target)) !== path.resolve(target)) {
      return yield* new ReviewError({ code: "setup_error", message: "Setup cannot edit a symlinked config file." })
    }
  }
  const text = target.endsWith(".json") ? JSON.stringify(decoded, null, 2) + "\n" : yield* Effect.gen(function*() {
    const existing = source === null ? "" : yield* fs.readFileString(target)
    const document = parseDocument(existing)
    if (!document.contents) return `organization:\n  source: ${JSON.stringify(decoded.organization!.source)}\n  ref: ${JSON.stringify(decoded.organization!.ref ?? "HEAD")}\n`
    document.set("organization", decoded.organization)
    return document.toString()
  })
  yield* Effect.scoped(Effect.gen(function*() {
    const temporary = yield* fs.makeTempDirectoryScoped({ directory: path.dirname(target), prefix: ".review-config-" })
    const file = path.join(temporary, "config")
    yield* fs.writeFileString(file, text)
    yield* fs.rename(file, target)
  }))
})

export const setup = Effect.fn("Setup.run")(function*(options: SetupOptions) {
  if (options.yes && !options.skipSkills && options.agents.length === 0) {
    return yield* new ReviewError({ code: "setup_error", message: "For non-interactive setup, select agents with --agent <name> (repeat as needed, or use --agent '*')." })
  }
  if (options.ref !== undefined && options.organization === undefined) {
    return yield* new ReviewError({ code: "setup_error", message: "--ref requires --organization. Edit an existing organization ref in review.yaml and run review sync --update." })
  }
  const path = yield* Path.Path
  const location = yield* repositoryRoot(options.repo).pipe(Effect.result)
  if (location._tag === "Failure" && (options.project || options.organization !== undefined || options.config !== undefined)) {
    return yield* new ReviewError({ code: "setup_error", message: "Project installation and organization setup require a Git repository. Run inside a project or pass --repo." })
  }
  const root = location._tag === "Success" ? location.success : null
  let lock: KnowledgeLock | null = null
  let declaration: { source: string | null; decoded: ConfigFile } | null = null
  if (root !== null) {
    const local = yield* readRepositoryConfig(root, options.config)
    let decoded = local.decoded
    if (options.organization !== undefined) {
      const requested = { source: options.organization, ref: options.ref ?? local.decoded.organization?.ref ?? "HEAD" }
      const resolved = yield* resolveOrganization(root, requested)
      if (local.decoded.organization) {
        const current = yield* resolveOrganization(root, local.decoded.organization)
        if (current.source !== resolved.source || current.ref !== resolved.ref) {
          return yield* new ReviewError({ code: "setup_error", message: "This repository already selects another organization source/ref. Edit its config and run review sync --update for an explicit change." })
        }
      } else {
        decoded = { ...decoded, organization: requested }
        declaration = { source: local.source, decoded }
      }
    }
    if (decoded.organization) {
      lock = (yield* prepareOrganization(root, decoded, false)).lock
    } else {
      yield* readRepositoryKnowledge(root, decoded.knowledge ?? [])
      yield* Effect.try({
        try: () => resolvePolicy(decoded, local.source, null),
        catch: (error) => error instanceof ReviewError ? error : new ReviewError({ code: "config_error", message: String(error) })
      })
    }
  }
  if (!options.skipSkills) yield* installSkill(root ?? path.resolve(options.repo), options)
  if (root !== null) {
    if (declaration) yield* saveDeclaration(root, declaration.source, declaration.decoded)
    if (lock && JSON.stringify(yield* readLock(root)) !== JSON.stringify(lock)) yield* writeLock(root, lock)
  }
  return { skillInstalled: !options.skipSkills, scope: options.project ? "project" : "user", repository: root, organization: lock }
})
