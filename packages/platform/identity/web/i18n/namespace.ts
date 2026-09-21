// web/i18n/namespace.ts
// Identity 的 i18n 命名空间标识（apikey / orgs 两个）。
//
// 与 `locales/**` 分开声明：组件只需要命名空间常量，不该因为 `useTranslation(NS.ORGS)`
// 就把两份字典拉进模块图（字典由宿主统一注册，见 web/i18n/index.ts 的说明）。
// 同款先例：`@fenix/resource-knowledge/web/i18n/namespace.ts` 的 `KNOWLEDGE_NS`。
//
// 字面量取自 `@fenix/web-runtime/i18n/namespace` 的共享 NS 表而不是再写一遍：该表已登记
// `APIKEY: "apikey"` 与 `ORGS: "orgs"`，包内再硬编码一个字面量会多出一处必须同步的真相来源，
// 而宿主注册字典时按的就是同一张表的取值。

import { type Namespace, NS } from "@fenix/web-runtime/i18n/namespace";

/** API Key 管理页命名空间；键的最终所在地是本包（计划 §4：键的 owner = 包的 owner）。 */
export const APIKEY_NS: Namespace = NS.APIKEY;

/** 组织与成员管理页命名空间。 */
export const ORGS_NS: Namespace = NS.ORGS;
