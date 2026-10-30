// Channel 的 i18n 命名空间标识。
//
// 与字典分开声明：组件只取常量，不应因为 `useTranslation(CHANNELS_NS)` 就把两份字典拉进模块图。
// `@fenix/web-runtime/i18n/namespace` 的中心表已登记同名字面量（`CHANNELS: "channels"`），
// 宿主按该表初始化 i18next 的 ns 列表，两处必须一致。

export const CHANNELS_NS = "channels";
