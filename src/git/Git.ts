import { Context, Effect, Layer } from "effect"
import { GitError } from "../domain/Errors.js"
import { makeProcessRunner } from "../process/runProcess.js"

const gitFailure = (args: ReadonlyArray<string>, detail: string): GitError =>
  new GitError({
    message: `git ${args.join(" ")} failed`,
    detail: detail.trim().slice(-2000)
  })

export class Git extends Context.Service<Git, {
  readonly repositoryRoot: (start: string) => Effect.Effect<string, GitError>
  readonly diff: (
    root: string,
    base: string,
    head: string,
    worktree: boolean
  ) => Effect.Effect<string, GitError>
}>()("review-runtime/Git") {
  static readonly layer = Layer.effect(
    Git,
    Effect.gen(function*() {
      const run = yield* makeProcessRunner()

      const exec = Effect.fn("Git.exec")(function*(root: string, args: ReadonlyArray<string>) {
        const result = yield* run({
          command: "git",
          args,
          cwd: root,
          timeoutSeconds: 30
        }).pipe(Effect.mapError((error) => gitFailure(args, error.detail || error.message)))
        if (result.exitCode !== 0) {
          return yield* gitFailure(args, result.stderr || result.stdout)
        }
        return result.stdout
      })

      const repositoryRoot = Effect.fn("Git.repositoryRoot")(function*(start: string) {
        const output = yield* exec(start, ["rev-parse", "--show-toplevel"])
        return output.trim()
      })

      const diff = Effect.fn("Git.diff")(function*(
        root: string,
        base: string,
        head: string,
        worktree: boolean
      ) {
        yield* exec(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`])
        const args = [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--find-renames",
          "--unified=3",
          base
        ]
        if (!worktree) {
          yield* exec(root, ["rev-parse", "--verify", "--quiet", `${head}^{commit}`])
          args.push(head)
        }
        return yield* exec(root, args)
      })

      return Git.of({ repositoryRoot, diff })
    })
  )
}
