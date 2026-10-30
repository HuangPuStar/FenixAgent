// web/i18n/namespace.ts
// 云盘的 i18n 命名空间标识。
//
// 与 `locales/**` 分开声明：组件与 hook 只需要命名空间常量，不该因为 `useTranslation(CLOUD_DRIVE_NS)`
// 就把两份字典拉进模块图（字典由宿主统一注册，见 web/i18n/index.ts 的说明）。
//
// 字面量取自 `@fenix/web-runtime/i18n/namespace` 的共享 NS 表（`CLOUD_DRIVE`），与宿主登记用的是
// 同一张表的取值；包内再硬编码一个字面量会多出一处必须同步的真相来源。

import { type Namespace, NS } from "@fenix/web-runtime/i18n/namespace";

/** 云盘命名空间；键的最终所在地是本包。 */
export const CLOUD_DRIVE_NS: Namespace = NS.CLOUD_DRIVE;
