// 此文件由 scripts/generate-module-registry.ts 生成，请勿手动编辑。

import { moduleManifest as manifest0 } from "@fenix/access-control/module";
import { moduleManifest as manifest1 } from "@fenix/agent-runtime/module";
import { moduleManifest as manifest2 } from "@fenix/identity/module";
import { moduleManifest as manifest3 } from "@fenix/resource-sandbox/module";
import { moduleManifest as manifest4 } from "../web/fenix.module.ts";
import type { ModuleManifest } from "@fenix/platform-sdk";

/** 构建期收集的可信模块集合；应用启动时只能从该集合选择模块。 */
export const generatedModuleManifests = [manifest0, manifest1, manifest2, manifest3, manifest4] as const satisfies readonly ModuleManifest[];
