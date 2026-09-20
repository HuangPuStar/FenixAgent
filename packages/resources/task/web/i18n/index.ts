// web/i18n/index.ts
// Task 命名空间的文案资源出口（计划 §4：键的最终所在地 = 包的 owner）。
//
// 宿主注册方式（已落地，apps/web/src/i18n/index.ts）：从子路径 `@fenix/resource-task/web/i18n` 导入本模块，
// 把 `tasksV2Resources.en/zh` 登记到 `TASKS_V2_NS`。为什么走子路径而不是 `./web` 根入口：宿主 i18n 模块在
// 应用启动时就求值，从根入口导入会把整个任务控制台页面图（页面、Radix 组件、api client）拉进首屏 bundle。
// 未注册时 i18next 回退为 key 回显，因此宿主接线必须先于页面启用。
//
// 现状（2026-09-20 实测）：宿主 `apps/web/src/i18n/index.ts:23` 已改为本子路径，`:119` / `:133` 以
// `TASKS_V2_NS` 登记两份资源，旧路径 `web/i18n/{en,zh}/tasks-v2.json` 已无任何引用。
//
// JSON 路径是包自身的契约（`web/__tests__/task-i18n.test.ts` 钉住 `locales/` 形状），宿主不得再按相对路径取。

import en from "./locales/en/tasks-v2.json";
import zh from "./locales/zh/tasks-v2.json";

export { TASKS_V2_NS } from "./namespace";

/**
 * Task 的 en / zh 文案资源；两份键结构完全一致（缺键会让界面回退显示 key，由
 * `web/__tests__/task-i18n.test.ts` 守护）。
 */
export const tasksV2Resources = { en, zh } as const;

export type TasksV2Resources = typeof tasksV2Resources;
