// 此文件由 scripts/generate-module-registry.ts 生成，请勿手动编辑。

import { moduleManifest as manifest0 } from "@fenix/access-control/module";
import { moduleManifest as manifest1 } from "@fenix/agent-config/module";
import { moduleManifest as manifest2 } from "@fenix/agent-runtime/module";
import { moduleManifest as manifest3 } from "@fenix/identity/module";
import { moduleManifest as manifest4 } from "@fenix/model-management/module";
import { moduleManifest as manifest5 } from "@fenix/resource-channel/module";
import { moduleManifest as manifest6 } from "@fenix/resource-knowledge/module";
import { moduleManifest as manifest7 } from "@fenix/resource-machine/module";
import { moduleManifest as manifest8 } from "@fenix/resource-mcp/module";
import { moduleManifest as manifest9 } from "@fenix/resource-memory/module";
import { moduleManifest as manifest10 } from "@fenix/resource-observer/module";
import { moduleManifest as manifest11 } from "@fenix/resource-plugin-market/module";
import { moduleManifest as manifest12 } from "@fenix/resource-prod-view/module";
import { moduleManifest as manifest13 } from "@fenix/resource-sandbox/module";
import { moduleManifest as manifest14 } from "@fenix/resource-skill/module";
import { moduleManifest as manifest15 } from "@fenix/resource-task/module";
import { moduleManifest as manifest16 } from "@fenix/resource-workflow/module";
import { moduleManifest as manifest17 } from "../web/fenix.module.ts";
import type { ModuleManifest } from "@fenix/platform-sdk";

/** 构建期收集的可信模块集合；应用启动时只能从该集合选择模块。 */
export const generatedModuleManifests = [manifest0, manifest1, manifest2, manifest3, manifest4, manifest5, manifest6, manifest7, manifest8, manifest9, manifest10, manifest11, manifest12, manifest13, manifest14, manifest15, manifest16, manifest17] as const satisfies readonly ModuleManifest[];
