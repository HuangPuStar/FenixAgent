// web/i18n/namespace.ts
// ProdView 的 i18n 命名空间标识。
//
// 字面量 `prodViews` 由 `@fenix/web-runtime/i18n/namespace` 的中心表声明：宿主注册各包 resources 时
// 需要一张完整的 ns 列表，包内再写一份字符串副本迟早与中心表漂移。这里只把它转出为本包的常量名，
// 消费方（本包组件、宿主装配）不必知道中心表结构，也让「prodViews 归本包所有」在导入点显式可见。
//
// 与 `web/i18n/index.ts`（字典资源）分开：组件只需要常量，不该因为 `useTranslation(PROD_VIEWS_NS)`
// 就把两份 JSON 拉进模块图；同款先例见 `@fenix/ui-components/i18n` 与 sandbox 的
// `web/i18n/namespace.ts`。

import { NS } from "@fenix/web-runtime/i18n/namespace";

/** 本包文案命名空间（`prodViews`）：键的最终所在地 = 包的 owner（计划 §4）。 */
export const PROD_VIEWS_NS = NS.PROD_VIEWS;
