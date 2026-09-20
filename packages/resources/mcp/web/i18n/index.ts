// web/i18n/index.ts
// MCP 命名空间的文案资源出口（计划 §4：键的最终所在地 = 包的 owner）。
//
// 本包的文案原本就在自己的 `mcp` 命名空间下（`apps/web/src/i18n/index.ts` 按 `NS.MCP` 注册），
// 不存在从 observer 命名空间寄居的键，因此这里只做「出口 + 归属声明」，不改动任何键或 JSON 路径。
// JSON 路径保持 `locales/{en,zh}/mcp.json`：宿主 i18n 引导已改为经本出口取 `mcpResources`，
// 不再按深层相对路径 import 这两个文件；本模块与宿主指向同一份 JSON，不复制字典。
//
// 子路径 `@fenix/resource-mcp/web/i18n` 与 `./web` 根入口分开：宿主 i18n 模块在应用启动时就求值，
// 从根入口导入会把整个页面图（页面、Radix 组件、api client）拉进首屏 bundle。
// 未注册时 i18next 回退为 key 回显，因此宿主接线必须先于页面启用。

import en from "./locales/en/mcp.json";
import zh from "./locales/zh/mcp.json";

export { MCP_NS } from "./namespace";

/**
 * MCP 的 en / zh 文案资源；两份键结构完全一致（缺键会让界面回退显示 key，
 * 由 `web/__tests__/mcp-i18n.test.ts` 守护）。
 */
export const mcpResources = { en, zh } as const;

export type McpResources = typeof mcpResources;
