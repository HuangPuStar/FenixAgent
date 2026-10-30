// Channel 命名空间的文案资源出口（键的最终所在地 = 包的 owner）。
//
// 宿主经子路径 `@fenix/resource-channel/web/i18n` 登记；从包根入口导入会把页面、Radix 组件与
// agent-config 的页面图一起拉进首屏 bundle，因此这里只导出字典与命名空间常量。

import en from "./locales/en/channels.json";
import zh from "./locales/zh/channels.json";

export { CHANNELS_NS } from "./namespace";

/** Channel 的 en / zh 文案；两份键结构一致，由宿主 i18n 契约测试与 `channels-page` 用例共同守护。 */
export const channelsResources = { en, zh } as const;

export type ChannelResources = typeof channelsResources;
