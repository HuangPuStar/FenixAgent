/**
 * 包内唯一的 i18n 命名空间。
 *
 * 组件通过 `useTranslation(UI_COMPONENTS_NS)` 读取文案，本包不自带 i18n 单例，
 * 也不注册任何 resource —— 宿主应用必须在渲染这些组件之前，把本包
 * `web/i18n/locales/<lng>/uiComponents.json` 的内容注册到同名命名空间，例如：
 *
 * ```ts
 * import en from "@fenix/ui-components/i18n/locales/en/uiComponents.json";
 * i18n.addResourceBundle("en", UI_COMPONENTS_NS, en, true, true);
 * ```
 *
 * 只有 `web/i18n/locales` 下的两个文件是包内文案真相来源；新增文案时必须同时补齐
 * en / zh 两份，并保持键结构一致，否则语言回退到 key 本身。
 */
export const UI_COMPONENTS_NS = "uiComponents";
