// web/i18n/index.ts
// Workflow V2 命名空间的文案资源出口（键的最终所在地 = 包的 owner）。
//
// 目前有导航项与画布宿主页（`canvas.*`）两组文案：列表页的键由 2D 落地时按同一命名空间追加，
// 键结构与旧包保持同命名空间（`workflows`），因此 2F 换包不会造成键的迁移。
//
// 宿主注册方式（2F 批次）：`apps/web/src/i18n/index.ts` 从子路径 `@fenix/resource-workflow-v2/web/i18n`
// 导入本模块，把 `workflowResources.en/zh` 登记到 `WORKFLOW_NS`。子路径而非 `./web` 根入口：宿主 i18n
// 模块在应用启动时求值，从根入口导入会把画布宿主页的依赖图一起拉进首屏 bundle。
//
// 未注册时 i18next 回退为 key 回显（`nav.workflow` 直接显示在侧栏），所以宿主接线必须先于本包 web 贡献
// 在 profile 里启用——两件事同属 2F 批次。

import en from "./locales/en/workflows.json";
import zh from "./locales/zh/workflows.json";

export { WORKFLOW_NS } from "./namespace";

/** Workflow V2 的 en / zh 文案资源；两份键结构必须一致（缺键会静默回显 key）。 */
export const workflowResources = { en, zh } as const;

export type WorkflowResources = typeof workflowResources;
