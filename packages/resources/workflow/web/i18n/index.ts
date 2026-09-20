// web/i18n/index.ts
// Workflow 命名空间的文案资源出口（计划 §4：键的最终所在地 = 包的 owner）。
//
// 为什么由本包转出：字典 `locales/{en,zh}/workflows.json` 里的键由 workflow 自己的页面与组件消费，
// 宿主 `apps/web/src/i18n/index.ts` 目前仍按**深相对路径**直接 import 这两份 JSON 并把 `WORKFLOWS:
// "workflows"` 写在宿主 `NS` 表里。
//
// 宿主注册方式（`apps/web/src/i18n/index.ts`）：从子路径 `@fenix/resource-workflow/web/i18n` 导入本模块，
// 把 `workflowResources.en/zh` 登记到 `WORKFLOW_NS`。子路径而非 `./web` 根入口：宿主 i18n 模块在应用
// 启动时求值，从根入口导入会把整个工作流页面图——React Flow、编辑器、agent-runtime 的 ChatPanel——
// 拉进首屏 bundle。宿主换线属 §4 共享文件范围，由编排者执行；本包不写 apps/**。
//
// 字典路径已按计划 §4 收敛到 `web/i18n/locales/{en,zh}/workflows.json`（与沙盒黄金样本同形），
// 宿主那一侧的深相对导入（`apps/web/src/i18n/index.ts:27-28`）因此在宿主换线前会解析失败——
// 两步属同一次 W3 串行落盘，包切片只提供宿主 patch 清单。
//
// 未注册时 i18next 回退为 key 回显（`editor.xxx` 直接显示在界面上），所以宿主接线必须先于页面启用。

import en from "./locales/en/workflows.json";
import zh from "./locales/zh/workflows.json";

export { WORKFLOW_NS } from "./namespace";

/**
 * Workflow 的 en / zh 文案资源；两份键结构完全一致（缺键会静默回显 key，
 * 由 `web/__tests__/workflow-i18n.test.ts` 守护）。
 */
export const workflowResources = { en, zh } as const;

export type WorkflowResources = typeof workflowResources;
