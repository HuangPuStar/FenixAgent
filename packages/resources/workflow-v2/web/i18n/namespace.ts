// web/i18n/namespace.ts
// Workflow V2 的 i18n 命名空间标识。
//
// 与字典分开声明：组件只需要命名空间常量，不该因为 `useTranslation(WORKFLOW_NS)` 就把字典拉进模块图
// （字典由宿主统一注册，见 web/i18n/index.ts 的说明）。同款先例：`@fenix/resource-workflow/web/i18n`
// 的 WORKFLOW_NS 与 `@fenix/ui-components/i18n` 的 UI_COMPONENTS_NS。
//
// 命名空间沿用旧包的 `workflows`（冻结 §2 的 `{ id: "workflow", namespace: "workflows" }`）：导航 id 与
// 路由 `/agent/workflow*` 都不变，文案字典也跟着沿用同一命名空间，2F 批次换包时不产生第二套键。

/** 字面量必须与宿主 `apps/web/src/i18n/index.ts` 的 `NS.WORKFLOWS` 一致（2F 批次由宿主改为引用本常量）。 */
export const WORKFLOW_NS = "workflows";
