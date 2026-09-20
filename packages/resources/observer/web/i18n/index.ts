// web/i18n/index.ts
// Observer 命名空间的文案资源出口（计划 §4：键的最终所在地 = 包的 owner）。
//
// 宿主注册方式（`apps/web/src/i18n/index.ts`）：经子路径 `@fenix/resource-observer/web/i18n` 导入本模块，
// 把 `observerResources.en/zh` 登记到 `OBSERVER_NS`。子路径而非 `./web` 根入口：宿主 i18n 模块在应用启动
// 时就求值，从根入口导入会把整个 Observer 控制台页面图（页面、Radix 组件、api client）拉进首屏 bundle。
// 未注册时 i18next 回退为 key 回显，因此宿主接线必须先于页面启用。
//
// JSON 路径是 `locales/{en,zh}/observer.json`（与 mcp / memory 等包同形）。旧布局 `web/i18n/{en,zh}/
// observer.json` 已删除，宿主 `apps/web/src/i18n/index.ts:19` 也已改为经本子路径取资源出口（不再有指向
// JSON 的深层相对导入），因此字典只有这一份、不会两处各留一份后静默漂移。宿主接线属「包切片不能写
// `apps/**`」的共享 patch，落盘记录见 README「边界残留」第 6 条。

import en from "./locales/en/observer.json";
import zh from "./locales/zh/observer.json";

export { OBSERVER_NS } from "./namespace";

/**
 * Observer 的 en / zh 文案资源；两份键结构完全一致（缺键会让界面回退显示 key，
 * 由 `web/__tests__/observer-i18n.test.ts` 守护）。
 */
export const observerResources = { en, zh } as const;

export type ObserverResources = typeof observerResources;
