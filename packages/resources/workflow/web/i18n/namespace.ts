// web/i18n/namespace.ts
// Workflow 的 i18n 命名空间标识。
//
// 与字典分开声明：组件只需要命名空间常量，不该因为 `useTranslation(WORKFLOW_NS)` 就把两份字典拉进
// 模块图（字典由宿主统一注册，见 web/i18n/index.ts 的说明）。同款先例：`@fenix/ui-components/lib/i18n`
// 只导出 `UI_COMPONENTS_NS`，字典放在 `@fenix/ui-components/i18n/locales/*/uiComponents.json`。

/**
 * 命名空间归属本包（键的最终所在地 = 包的 owner，计划 §4），因此常量也由本包声明。
 * 字面量必须与宿主 `apps/web/src/i18n/index.ts` 的 `NS.WORKFLOWS` 一致；该表已登记 `workflows`，
 * 待它改为引用本常量后即可直接取用同一字面量（属 §1.6 / 宿主接线范围，本包不写 apps/**）。
 */
export const WORKFLOW_NS = "workflows";
