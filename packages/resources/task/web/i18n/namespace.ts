// web/i18n/namespace.ts
// Task 的 i18n 命名空间标识。
//
// 与 `locales/{en,zh}/tasks-v2.json` 分开声明：组件只需要命名空间常量，不该因为 `useTranslation(TASKS_V2_NS)`
// 就把两份字典拉进模块图（字典由宿主统一注册，见 web/i18n/index.ts 的说明）。
//
// 值取自 `@fenix/web-runtime/i18n/namespace` 的共享 NS 表而不是在本包重新写一份字面量：两份字面量一旦
// 分歧，症状是文案整片回退成 key 回显（宿主按旧名字注册、组件按新名字取），且构建期不可见。同款先例见
// `@fenix/ui-components/lib/i18n` 的 `UI_COMPONENTS_NS`。
// 实测（2026-09-20）：宿主 `apps/web/src/i18n/index.ts:23` 已从本包的 `TASKS_V2_NS` 取值并以其登记资源，
// 宿主不再持有 `"tasksV2"` 字面量（`NS` 表改为 `{ ...SHARED_NS }`，值由中心表持有）。
//
// 键的最终所在地 = 包的 owner（计划 §4）：`tasksV2` 命名空间下的全部键由本包自持，
// 键集合变更只在本包内发生。

import { NS } from "@fenix/web-runtime/i18n/namespace";

/** Task 的 i18n 命名空间（`tasksV2`）。 */
export const TASKS_V2_NS = NS.TASKS_V2;
