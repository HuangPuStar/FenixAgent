// web/i18n/index.ts
// 本包命名空间的文案资源出口（计划 §4：键的最终所在地 = 包的 owner）。
//
// 宿主注册方式（`apps/web/src/i18n/index.ts`）：经子路径 `@fenix/ui-components/i18n` 导入本模块，
// 把 `uiComponentsResources.en/zh` 登记到 `UI_COMPONENTS_NS`。用子路径而非包根入口：宿主 i18n 模块
// 在应用启动时就求值，从根入口导入会把整包组件图（chat 体系、Radix、文件预览）拉进首屏 bundle。
// 未注册时 i18next 回退为 key 回显，因此宿主接线必须先于页面启用。
//
// 本模块是「`UI_COMPONENTS` 命名空间尚未接入宿主」这一已知缺陷（stage-2 计划 §1.3）的包侧出口：
// 出口就位后宿主接线属共享 patch，与 T9「i18n 归属重划」一并落地。
//
// JSON 路径是 `locales/{en,zh}/uiComponents.json`（与 observer / mcp / memory 等包同形）。
// 两份键结构必须一致，否则缺键的语种会回退显示 key（由 `web/__tests__/i18n-barrel.test.ts` 守护）。

import en from "./locales/en/uiComponents.json";
import zh from "./locales/zh/uiComponents.json";

export { UI_COMPONENTS_NS } from "./namespace";

/**
 * 本包的 en / zh 文案资源；两份键结构完全一致（缺键会让界面回退显示 key）。
 */
export const uiComponentsResources = { en, zh } as const;

export type UiComponentsResources = typeof uiComponentsResources;
