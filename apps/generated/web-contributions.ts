// 此文件由 scripts/generate-web-contributions.ts 生成，请勿手动编辑。

import { webContribution as webContribution0 } from "@fenix/agent-config/web/contribution";
import { webContribution as webContribution1 } from "@fenix/identity/web/contribution";
import { webContribution as webContribution2 } from "@fenix/resource-knowledge/web/contribution";
import { webContribution as webContribution3 } from "@fenix/resource-mcp/web/contribution";
import { webContribution as webContribution4 } from "@fenix/resource-memory/web/contribution";
import { webContribution as webContribution5 } from "@fenix/model-management/web/contribution";
import { webContribution as webContribution6 } from "@fenix/resource-skill/web/contribution";
import { webContribution as webContribution7 } from "@fenix/resource-task/web/contribution";
import { webContribution as webContribution8 } from "@fenix/resource-workflow/web/contribution";
import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";

/**
 * 装配 profile 选定的浏览器贡献，顺序与 `deploy/assembly/ce.json` 的 `web` 列表一致。
 *
 * 服务端侧的同名概念是 `bootstrap.webContributions`——那里拿到的是本文件每一条的**说明符字符串**；
 * 本文件是它的浏览器一半，真正把载荷 import 进来。两端由同一份 profile 与同一批 manifest 派生。
 */
export const generatedWebContributions = [webContribution0, webContribution1, webContribution2, webContribution3, webContribution4, webContribution5, webContribution6, webContribution7, webContribution8] as const satisfies readonly WebAppContribution[];
