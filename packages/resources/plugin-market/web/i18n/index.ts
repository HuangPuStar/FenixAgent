// 插件市场命名空间的文案资源出口（键的最终所在地 = 包的 owner）。
//
// 宿主注册方式（共享文件 `apps/web/src/i18n/index.ts`）：从子路径 `@fenix/resource-plugin-market/web/i18n`
// 导入本模块，把 `pluginMarketResources.en/zh` 登记到 `PLUGIN_MARKET_NS`。子路径而非 `./web` 根入口：宿主
// i18n 模块在应用启动时就求值，从根入口导入会把整个市场页面图（页面、Radix 组件、api client）拉进首屏
// bundle。未注册时 i18next 回退为 key 回显，因此宿主接线必须先于页面启用。

import en from "./locales/en/pluginMarket.json";
import zh from "./locales/zh/pluginMarket.json";

export { PLUGIN_MARKET_NS } from "./namespace";

/**
 * 插件市场的 en / zh 文案资源；两份键结构完全一致（缺键会让界面回退显示 key，由
 * `web/__tests__/plugin-market-i18n.test.ts` 守护）。
 */
export const pluginMarketResources = { en, zh } as const;

export type PluginMarketResources = typeof pluginMarketResources;
