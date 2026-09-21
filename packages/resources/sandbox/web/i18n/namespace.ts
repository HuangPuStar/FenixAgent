// web/i18n/namespace.ts
// Sandbox 的 i18n 命名空间标识。
//
// 与 `locales/**` 分开声明：组件只需要命名空间常量，不该因为 `useTranslation(SANDBOX_NS)`
// 就把两份字典拉进模块图（字典由宿主统一注册，见 web/i18n/index.ts 的说明）。
// 同款先例：`@fenix/ui-components/i18n` 的命名空间常量 `UI_COMPONENTS_NS`，字典也从同出口导出。

/**
 * 命名空间归属本包（键的最终所在地 = 包的 owner，计划 §4），因此常量也由本包声明。
 * `@fenix/web-runtime/i18n/namespace` 的 `NS` 表只登记名称以保证宿主 ns 列表齐全，
 * 待该表补上 `SANDBOX` 后宿主可直接取用同一字面量。
 */
export const SANDBOX_NS = "sandbox";
