// web/i18n/index.ts
// 工单命名空间的文案资源出口（键的最终所在地 = 包的 owner）。
//
// 宿主经**子路径** `@fenix/resource-tickets/web/i18n` 消费本模块（apps/web/src/i18n/index.ts），而不是
// `./web` 根入口：宿主 i18n 在应用启动时求值，从根入口导入会把整张工单页面图（页面、表格、弹窗、
// api client）拉进首屏 bundle。未登记时 i18next 回退为 key 回显，**构建期不报错**，因此宿主接线必须先于
// 页面启用。
//
// 字典路径 `locales/{en,zh}/tickets.json` 是包自身的契约（文件名 = 命名空间字面量），宿主不得按相对路径取。

import en from "./locales/en/tickets.json";
import zh from "./locales/zh/tickets.json";

export { TICKETS_NS } from "./namespace";

/** 工单的 en / zh 文案资源；两份键结构逐键一致（缺键会让界面回退显示 key）。 */
export const ticketsResources = { en, zh } as const;

export type TicketsResources = typeof ticketsResources;
