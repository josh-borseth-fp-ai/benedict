import { Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { Git } from "./git/Git.js"
import { CodeRetriever } from "./intelligence/Retriever.js"
import { ReviewConfigStore } from "./review/config.js"
import { SkillRegistry } from "./review/skills.js"

export const AppLayer = Layer.mergeAll(
  Git.layer,
  CodeRetriever.layer,
  ReviewConfigStore.layer,
  SkillRegistry.layer
).pipe(Layer.provideMerge(NodeServices.layer))
