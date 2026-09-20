// web/i18n/namespace.ts
// Skill 的 i18n 命名空间标识。
//
// 与 `locales/**` 分开声明：组件只需要命名空间常量，不该因为 `useTranslation(SKILL_NS)`
// 就把两份字典拉进模块图（字典由宿主统一注册，见 web/i18n/index.ts 的说明）。
// 同款先例：`@fenix/ui-components/lib/i18n` 只导出 `UI_COMPONENTS_NS`。

/**
 * 命名空间归属本包（键的最终所在地 = 包的 owner，计划 §4），因此常量也由本包声明。
 * `@fenix/web-runtime/i18n/namespace` 的 `NS.SKILLS` 登记的是同一个字面量，供宿主拼 `ns` 列表。
 */
export const SKILL_NS = "skills";
