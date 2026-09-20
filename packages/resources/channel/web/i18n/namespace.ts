// web/i18n/namespace.ts
// Channel 的 i18n 命名空间标识。
//
// 与字典分开声明：组件只需要命名空间常量，不该因为 `useTranslation(CHANNELS_NS)` 就把两份字典
// 拉进模块图（字典由宿主统一注册，见 web/i18n/index.ts 的说明）。同款先例：
// `@fenix/resource-sandbox/web/i18n/namespace` 与 `@fenix/ui-components/lib/i18n`。

/**
 * 命名空间归属本包（键的最终所在地 = 包的 owner，计划 §4），因此常量也由本包声明。
 * `@fenix/web-runtime/i18n/namespace` 的 `NS` 表已登记同名字面量（`CHANNELS: "channels"`），
 * 两处必须保持一致：宿主按该表初始化 i18next 的 ns 列表。
 */
export const CHANNELS_NS = "channels";
