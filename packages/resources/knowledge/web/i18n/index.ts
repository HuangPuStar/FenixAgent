// Knowledge 命名空间的文案资源出口（计划 §4：键的最终所在地 = 包的 owner）。
//
// 字典文件位置**刻意不动**（`web/i18n/locales/{en,zh}/knowledge.json`）：宿主
// `apps/web/src/i18n/index.ts` 目前按深相对路径导入这两份 JSON 并登记到 `NS.KNOWLEDGE`，而该文件是
// §4 的共享文件（只有编排者能改）。本模块只把同一份字典再导出一遍，供宿主后续改用
// `@fenix/resource-knowledge/web/i18n` 子路径（与 sandbox 的接线形态一致）；在宿主切换之前，
// 两条路径读的是同一份文件，不会产生第二份字典。
//
// 子路径而非 `./web` 根入口：宿主 i18n 模块在应用启动时就求值，从根入口导入会把整个知识库页面图
// （页面、Radix 组件、api client、@antv/g6）拉进首屏 bundle。
//
// 键归属实测（2026-09-20）：`en` / `zh` 各 56 个顶层键、247 个扁平键（含 `accessDenied.*` 与 error/retry
// 收口补齐的 `loadFailure.*`），两语言键集合完全一致，且全部
// 落在 knowledge 域；`packages/resources/observer/web/i18n/*/observer.json` 下没有本包键，
// 因此本次没有「从 observer 命名空间迁出」的动作（movedIn / movedOut 均为空）。

import en from "./locales/en/knowledge.json";
import zh from "./locales/zh/knowledge.json";

export { KNOWLEDGE_NS } from "./namespace";

/**
 * Knowledge 的 en / zh 文案资源；两份键结构完全一致（缺键会让界面回退显示 key，
 * 由 `web/__tests__/knowledge-i18n.test.ts` 守护）。
 */
export const knowledgeResources = { en, zh } as const;

export type KnowledgeResources = typeof knowledgeResources;
