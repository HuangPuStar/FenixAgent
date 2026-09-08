import { sharedAgentRuntime } from "@fenix-ce/agent-runtime";
import type { ModuleManifest } from "@fenix-ce/platform-sdk";

/** 原样复用 runtime 的装配声明；资源与授权不会进入 runtime 包。 */
export const moduleManifest = {
  id: "shared-agent-runtime",
  kind: "runtime",
  dependsOn: [],
  create: () => sharedAgentRuntime,
} satisfies ModuleManifest;
