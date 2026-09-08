// 此文件由 scripts/generate-module-registry.ts 生成，请勿手动编辑。

import { moduleManifest as manifest0 } from "@fenix-ce/agent-config/module";
import { moduleManifest as manifest1 } from "@fenix-ce/agent-runtime/module";
import { moduleManifest as manifest2 } from "@fenix-ce/community-access-control/module";
import { moduleManifest as manifest3 } from "@fenix-ee/access-control/module";
import { moduleManifest as manifest4 } from "@fenix-ee/agent-config/module";

/** 构建期收集的 EE 与固定 CE submodule 模块集合。 */
export const generatedModuleManifests = [manifest0, manifest1, manifest2, manifest3, manifest4] as const;
