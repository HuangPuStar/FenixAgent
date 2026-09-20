// web/i18n/index.ts
// Channel 命名空间的文案资源出口（计划 §4：键的最终所在地 = 包的 owner）。
//
// 字典的物理路径是 `web/i18n/locales/{en,zh}/channels.json`（任务 1.3 §4 的统一形状，
// 对照 `packages/resources/sandbox/web/i18n/`）。宿主**不得**再按相对路径 import 包内 JSON：
// 路径属于本包实现，改动会静默断链。
//
// 宿主注册方式（§1.6 WebShell 装配）：宿主 `apps/web/src/i18n/index.ts` 从子路径
// `@fenix/resource-channel/web/i18n` 导入本模块，把 `channelsResources.en/zh` 登记到 `CHANNELS_NS`。
// 子路径而非 `./web` 根入口：宿主 i18n 模块在应用启动时就求值，从根入口导入会把整个通道页面图
// （页面、Radix 组件、api client）拉进首屏 bundle。未注册时 i18next 回退为 key 回显，
// 因此宿主接线必须先于页面启用；宿主注册的落盘状态与补丁见 README「边界残留」。

import en from "./locales/en/channels.json";
import zh from "./locales/zh/channels.json";

export { CHANNELS_NS } from "./namespace";

/**
 * Channel 的 en / zh 文案资源；两份键结构完全一致（缺键会让界面回退显示 key，
 * 由 `web/__tests__/channel-i18n.test.ts` 与 `channel-i18n-contract.test.ts` 两侧守护）。
 */
export const channelsResources = { en, zh } as const;

export type ChannelResources = typeof channelsResources;
