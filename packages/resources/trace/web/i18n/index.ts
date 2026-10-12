// web/i18n/index.ts
// Trace 命名空间的文案资源出口（键的最终所在地 = 包的 owner）。
//
// 宿主注册方式（apps/web/src/i18n/index.ts）：从子路径 `@fenix/resource-trace/web/i18n` 导入本模块，把
// `traceResources.en/zh` 登记到 `TRACE_NS`。走子路径而不是 `./web` 根入口 —— 宿主 i18n 模块在应用启动时
// 求值，从根入口导入会把面板整条 UI 图（图布局、JSON 渲染、Radix 组件）拉进首屏 bundle。
//
// 一个命名空间拆成三份字典，按**顶层键段**分工：`panel` / `list`（面板壳）在 `trace-panel.json`，
// `graph`（调用图）与 `detail`（节点详情）各在自己的文件里。原因是分区维护——图与详情是两个独立演进的
// 区域，合并成一份之后每次改动都会在同一个文件上冲突；三份的顶层键互不重叠，合并顺序不影响结果。
// 缺键会让界面回退显示 key，故 en/zh 必须逐键对应（由 `web/__tests__/trace-i18n.test.ts` 守护）。

import enDetail from "./locales/en/trace-detail.json";
import enGraph from "./locales/en/trace-graph.json";
import enPanel from "./locales/en/trace-panel.json";
import zhDetail from "./locales/zh/trace-detail.json";
import zhGraph from "./locales/zh/trace-graph.json";
import zhPanel from "./locales/zh/trace-panel.json";

export { TRACE_NS } from "./namespace";

/** Trace 的 en / zh 文案资源（三份区域字典的并集）。 */
export const traceResources = {
  en: { ...enPanel, ...enGraph, ...enDetail },
  zh: { ...zhPanel, ...zhGraph, ...zhDetail },
} as const;

export type TraceResources = typeof traceResources;
