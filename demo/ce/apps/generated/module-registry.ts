// 此文件由 scripts/generate-module-registry.ts 生成，请勿手动编辑。

import { moduleManifest as manifest0 } from "@fenix-ce/agent-config/module";
import { moduleManifest as manifest1 } from "@fenix-ce/agent-runtime/module";
import { moduleManifest as manifest2 } from "@fenix-ce/community-access-control/module";

/** 构建期收集的可信模块集合；apps 在启动时按 assembly profile 选择其中的模块。 */
export const generatedModuleManifests = [manifest0, manifest1, manifest2] as const;
