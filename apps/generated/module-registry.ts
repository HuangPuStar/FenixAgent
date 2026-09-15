// 此文件由 scripts/generate-module-registry.ts 生成，请勿手动编辑。

import { moduleManifest as manifest0 } from "@fenix/access-control/module";
import type { ModuleManifest } from "@fenix/platform-sdk";

/** 构建期收集的可信模块集合；应用启动时只能从该集合选择模块。 */
export const generatedModuleManifests = [manifest0] as const satisfies readonly ModuleManifest[];
