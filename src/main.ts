#!/usr/bin/env node
import { NodeRuntime } from "@effect/platform-node"
import { run } from "./cli.js"

NodeRuntime.runMain(run)
