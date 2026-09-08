import { CommunityAccessControl } from "@fenix-ce/community-access-control";
import type { ModuleManifest } from "@fenix-ce/platform-sdk";

/** CE 默认身份与授权模块的自描述，供构建期 registry 生成器收集。 */
export const moduleManifest = {
  id: "community",
  kind: "access-control",
  dependsOn: [],
  create: () => new CommunityAccessControl(),
} satisfies ModuleManifest;
