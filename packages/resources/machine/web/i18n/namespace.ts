// web/i18n/namespace.ts
// Machine 的 i18n 命名空间标识。
//
// 与 `locales/**` 分开声明：组件与 hook 只需要命名空间常量，不该因为 `useTranslation(MACHINE_NS)`
// 就把两份字典拉进模块图（字典由宿主统一注册，见 web/i18n/index.ts 的说明）。

/**
 * 命名空间归属本包（键的最终所在地 = 包的 owner），因此常量也由本包声明。
 * 值在本包声明而非取自 `@fenix/web-runtime/i18n/namespace`：中心表尚未收录 machine 项，
 * 同款先例是 `@fenix/resource-sandbox` 的 `SANDBOX_NS`——待中心表补上 `MACHINE` 后可直接改用
 * `NS.MACHINE`。两份字面量一旦分歧，症状是文案整片回退成 key 回显（宿主按旧名字注册、组件按
 * 新名字取），且构建期不可见。
 */
export const MACHINE_NS = "machine";
