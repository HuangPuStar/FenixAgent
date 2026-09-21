// web/i18n/namespace.ts
// Hindsight 记忆的 i18n 命名空间标识。
//
// 与 `locales/**` 分开声明：组件只需要命名空间常量，不该因为 `useTranslation(HINDSIGHT_NS)`
// 就把两份字典拉进模块图（字典由宿主统一注册，见 web/i18n/index.ts 的说明）。
// 同款先例：`@fenix/ui-components/i18n` 的命名空间常量 `UI_COMPONENTS_NS`。
//
// 组件当前经 `@fenix/web-runtime/i18n/namespace` 的 `NS.HINDSIGHT` 取同名常量（该表登记全部
// 命名空间名称，保证宿主 `ns` 列表齐全）。两处字面量必须逐字一致——`web/__tests__/memory-i18n.test.ts`
// 静态断言这一点，避免「宿主注册的 ns 名」与「包内声明」漂移后界面整片回退成 key。
export const HINDSIGHT_NS = "hindsight";
