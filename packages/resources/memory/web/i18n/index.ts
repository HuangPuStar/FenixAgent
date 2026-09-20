// web/i18n/index.ts
// Hindsight 记忆命名空间的文案资源出口（计划 §4：键的最终所在地 = 包的 owner）。
//
// 宿主注册方式（apps/web/src/i18n/index.ts）：从子路径 `@fenix/resource-memory/web/i18n` 导入本模块，
// 把 `hindsightResources.en/zh` 登记到 `HINDSIGHT_NS`。接线已落盘（2026-09-20 实测该文件第 18 行
// import、第 123 / 137 行分别为 `hindsightResources.en` / `.zh`）：宿主不再以深层相对路径直接 import
// 这两份 JSON，本出口是文案的唯一来源。
// 子路径而非 `./web` 根入口：宿主 i18n 模块在应用启动时就求值，从根入口导入会把整个记忆控制台页面图
// （页面、Radix 组件、api client）拉进首屏 bundle。未注册时 i18next 回退为 key 回显，因此宿主接线必须
// 先于页面启用。
//
// 字典路径固定为 `web/i18n/locales/{en,zh}/hindsight.json`（由本文件相对 import 后经出口转出，
// 宿主不再直读盘上 JSON）；`web/__tests__/memory-i18n.test.ts` 以「文件真正在哪」的方式钉住该路径
// 与命名空间字面量的一致性。

import en from "./locales/en/hindsight.json";
import zh from "./locales/zh/hindsight.json";

export { HINDSIGHT_NS } from "./namespace";

/**
 * Hindsight 记忆的 en / zh 文案资源；两份键结构完全一致（缺键会让界面回退显示 key，
 * 由 `web/__tests__/memory-i18n.test.ts` 守护）。
 */
export const hindsightResources = { en, zh } as const;

export type HindsightResources = typeof hindsightResources;
