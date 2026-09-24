// web/i18n/namespace.ts
// 插件市场的 i18n 命名空间标识。
//
// 与 `locales/**` 分开声明：页面只需要命名空间常量，不该因为 `useTranslation(PLUGIN_MARKET_NS)` 就把两份
// 字典拉进模块图（字典由宿主统一注册，见 web/i18n/index.ts 的说明）。同款先例：`@fenix/ui-components/i18n`
// 的命名空间常量 `UI_COMPONENTS_NS`，字典也从同出口导出。

/**
 * 命名空间归属本包（键的最终所在地 = 包的 owner），因此常量也由本包声明，字面量与
 * `locales/{en,zh}/pluginMarket.json` 的文件名一致。
 *
 * 刻意**不**取 `@fenix/web-runtime/i18n/namespace` 中心表的取值风格：中心表是跨包共享的名称注册表，为
 * 本包补一条要改共享契约，而命名空间名的消费者只有宿主注册处（`apps/web/src/i18n/index.ts` 从本模块
 * 导入常量）。待中心表登记 `PLUGIN_MARKET` 后，本常量与它取值相同，届时可直接改成引用。
 */
export const PLUGIN_MARKET_NS = "pluginMarket";
