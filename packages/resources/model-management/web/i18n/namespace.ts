// Model-management 的 i18n 命名空间标识。
//
// 与 `locales/**` 分开声明：页面只需要命名空间常量，不该因为 `useTranslation(MODELS_NS)`
// 就把两份字典（约 470 个叶子键）拉进模块图（字典由宿主统一注册，见 web/i18n/index.ts 的说明）。
// 同款先例：`@fenix/ui-components/lib/i18n` 只导出 `UI_COMPONENTS_NS`，字典在
// `@fenix/ui-components/i18n/locales/*/uiComponents.json`。
//
// 字面量取自 `@fenix/web-runtime/i18n/namespace` 的共享 NS 表而不是再写一遍：该表已登记
// `MODELS: "models"`，包内再硬编码一个字面量会多出一处必须同步的真相来源，而宿主注册字典时按的
// 就是同一张表的取值。
//
// 命名空间名保持 `models` 而不是 `modelManagement`：宿主 `apps/web/src/i18n/index.ts` 已按
// `NS.MODELS` 登记该命名空间，`web/i18n/locales/{en,zh}/models.json` 的文件名必须与之对应；
// 改名等于让宿主侧多一次共享文件改动，而键的 owner 归属与命名空间名无关。

import { type Namespace, NS } from "@fenix/web-runtime/i18n/namespace";

/** Provider / Model / 模型网关命名空间；键的最终所在地是本包（计划 §4：键的 owner = 包的 owner）。 */
export const MODELS_NS: Namespace = NS.MODELS;
