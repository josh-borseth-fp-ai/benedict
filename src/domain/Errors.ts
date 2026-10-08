import { Schema } from "effect"

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  message: Schema.String,
  detail: Schema.String
}) {}

export class ToolError extends Schema.TaggedError<ToolError>()("ToolError", {
  message: Schema.String,
  detail: Schema.String
}) {}

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  kind: Schema.Literals(["spawn", "exit", "decode", "timeout"]),
  message: Schema.String,
  detail: Schema.String
}) {}

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  detail: Schema.String
}) {}
