import type { ModuleManifest } from "@fenix/platform-sdk";

/** CE 默认授权模块的静态身份；具体工厂由 PLT-01 在实现授权能力时补齐。 */
export const moduleManifest = {
  id: "access-control",
  kind: "access-control",
  dependsOn: [],
  capabilities: ["platform.access-control"],
} satisfies ModuleManifest;
