// web/i18n/namespace.ts
// Trace 面板的 i18n 命名空间标识。
//
// 与字典文件分开声明：组件只需要命名空间常量，不该因为 `useTranslation(TRACE_NS)` 就把三份字典拉进模块图
// （字典由宿主统一注册，见 web/i18n/index.ts）。值取自 `@fenix/web-runtime/i18n/namespace` 的中心表，不在
// 本包重写字面量——两份字面量一旦分歧，症状是整片文案回退成 key 且构建期不可见（同款先例见
// `@fenix/resource-task/web/i18n/namespace.ts`）。

import { NS } from "@fenix/web-runtime/i18n/namespace";

/** Trace 面板的 i18n 命名空间（`trace`）。 */
export const TRACE_NS = NS.TRACE;
