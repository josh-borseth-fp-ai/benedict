import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { stripVTControlCharacters } from "node:util"
import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { readRepositoryConfig } from "./config.js"
import { repositoryRoot } from "./git.js"
import { ReviewError, configPath } from "./model.js"
import type { ConfigFile, OrganizationRevision } from "./model.js"
import { loadOrganization, resolveSource, reviewDirectory, writeAtomically } from "./organization.js"

export interface SetupOptions {
  readonly repo: string
  readonly organization?: string
  readonly project: boolean
  readonly agents: ReadonlyArray<string>
  readonly yes: boolean
  readonly skipSkills: boolean
}

const bundledSkill = fileURLToPath(new URL("../.agents/skills/benedict", import.meta.url))
const installer = fileURLToPath(new URL("./bin/cli.mjs", pathToFileURL(createRequire(import.meta.url).resolve("skills/package.json"))))

export const installSkill = Effect.fn("Setup.installSkill")(function*(cwd: string, options: SetupOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const args = [installer, "add", bundledSkill, "--skill", "benedict",
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
        entry.name === "benedict" && entry.status === "installed" && Array.isArray(entry.agents) && entry.agents.length > 0)
    },
    catch: () => new ReviewError({ code: "setup_error", message: "The skill installer returned an invalid result. Organization configuration was not changed." })
  }) : !/Installation cancelled|Failed to install/.test(stripVTControlCharacters(result.stdout))
  if (result.exitCode !== 0 || !installed) return yield* new ReviewError({ code: "setup_error", message: `Skill installation failed or was cancelled (exit ${result.exitCode}). Organization configuration was not changed.` })
})

const saveDeclaration = Effect.fn("Setup.saveDeclaration")(function*(root: string, source: string | null, decoded: ConfigFile) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const target = source ?? path.join(yield* reviewDirectory(root), path.basename(configPath))
  if ((yield* fs.exists(target)) && (yield* fs.realPath(target)) !== path.resolve(target)) {
    return yield* new ReviewError({ code: "setup_error", message: "Setup cannot edit a symlinked config file." })
  }
  yield* writeAtomically(target, JSON.stringify(decoded, null, 2) + "\n")
})

export const setup = Effect.fn("Setup.run")(function*(options: SetupOptions) {
  if (options.yes && !options.skipSkills && options.agents.length === 0) {
    return yield* new ReviewError({ code: "setup_error", message: "For non-interactive setup, select agents with --agent <name> (repeat as needed, or use --agent '*')." })
  }
  const path = yield* Path.Path
  const location = yield* repositoryRoot(options.repo).pipe(Effect.result)
  if (location._tag === "Failure" && (options.project || options.organization !== undefined)) {
    return yield* new ReviewError({ code: "setup_error", message: "Project installation and organization setup require a Git repository. Run inside a project or pass --repo." })
  }
  const root = location._tag === "Success" ? location.success : null
  let organization: OrganizationRevision | null = null
  let declaration: { source: string | null; decoded: ConfigFile } | null = null
  if (root !== null && options.organization !== undefined) {
    const local = yield* readRepositoryConfig(root)
    const requested = { source: options.organization }
    if (local.decoded.organization) {
      if ((yield* resolveSource(root, local.decoded.organization)) !== (yield* resolveSource(root, requested))) {
        return yield* new ReviewError({ code: "setup_error", message: `This repository already selects another organization source. Edit ${configPath} to change it.` })
      }
    } else {
      declaration = { source: local.source, decoded: { ...local.decoded, organization: requested } }
    }
    // Fetch once so an unreachable source or a repository without skills fails before anything is written.
    organization = (yield* loadOrganization(root, requested)).organization
  }
  if (!options.skipSkills) yield* installSkill(root ?? path.resolve(options.repo), options)
  if (root !== null && declaration) yield* saveDeclaration(root, declaration.source, declaration.decoded)
  return { skillInstalled: !options.skipSkills, scope: options.project ? "project" : "user", repository: root, organization, configChanged: declaration !== null }
})
