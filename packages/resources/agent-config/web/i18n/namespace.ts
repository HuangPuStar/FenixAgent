// web/i18n/namespace.ts
// agent-config 的 i18n 命名空间标识。
//
// 与 `locales/**` 分开声明：组件只需要命名空间常量，不该因为 `useTranslation(AGENTS_NS)`
// 就把整份字典拉进模块图（字典由宿主统一注册，见 web/i18n/index.ts）。
// 同款先例：`@fenix/ui-components/i18n` 的命名空间常量 `UI_COMPONENTS_NS`。
//
// 字面量固定为 "agents"：宿主 `apps/web/src/i18n/index.ts` 用本模块的 `AGENTS_NS` 注册该命名空间，
// 消费方（编辑器、站点页、原寄居宿主的 `AgentManagementPage.tsx`）一律按同一名字取值。改名会同时
// 切断宿主注册与全部消费方，收益不足以抵消代价，故沿用原名；命名空间的所有权（字典文件）在本包。
// `@fenix/web-runtime/i18n/namespace` 的 `NS` 表只登记名称以保证宿主 ns 列表齐全。

/**
 * 命名空间归属本包（键的最终所在地 = 包的 owner，计划 §4），因此常量也由本包声明。
 */
export const AGENTS_NS = "agents";
