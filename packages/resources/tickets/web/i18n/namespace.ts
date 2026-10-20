// web/i18n/namespace.ts
// tickets 的 i18n 命名空间标识。
//
// 与 `locales/{en,zh}/tickets.json` 分开声明：组件只需要命名空间常量，不该因为 `useTranslation(TICKETS_NS)`
// 就把两份字典拉进模块图（字典由宿主统一注册，见 web/i18n/index.ts 的说明）。
//
// 值取自 `@fenix/web-runtime/i18n/namespace` 的共享 NS 表而不是在本包重新写一份字面量：两份字面量一旦
// 分歧，症状是文案整片回退成 key 回显（宿主按旧名字注册、组件按新名字取），且构建期不可见。同款先例见
// `@fenix/resource-task` 的 `TASKS_V2_NS` 与 `@fenix/ui-components/i18n` 的 `UI_COMPONENTS_NS`。
//
// 键的最终所在地 = 包的 owner：`tickets` 命名空间下的全部键由本包自持，键集合变更只在本包内发生。

import { NS } from "@fenix/web-runtime/i18n/namespace";

/** 工单的 i18n 命名空间（`tickets`）；值取自共享中心表。 */
export const TICKETS_NS = NS.TICKETS;
