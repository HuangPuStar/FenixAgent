// web/i18n/index.ts
// Sandbox 命名空间的文案资源出口（计划 §4：键的最终所在地 = 包的 owner）。
//
// 为什么要从 observer 命名空间迁出：这批键原寄居在
// `packages/resources/observer/web/i18n/*/observer.json` 的 observer 命名空间下，
// 但消费方是 sandbox 自己的页面与组件；跨包寄居会让「文案所有者」与「字典策略」
// 分属两个 owner，任何一侧改动都可能静默清空另一侧的文案。迁出后本包自持 `sandbox`
// 命名空间，observer 侧同批只删除寄居键、不保留副本。
//
// 宿主注册方式（apps/web/src/i18n/index.ts）：从子路径 `@fenix/resource-sandbox/web/i18n` 导入本模块，
// 把 `sandboxResources.en/zh` 登记到 `SANDBOX_NS`。子路径而非 `./web` 根入口：宿主 i18n 模块在应用
// 启动时就求值，从根入口导入会把整个沙盒页面图（页面、Radix 组件、api client）拉进首屏 bundle。
// 未注册时 i18next 回退为 key 回显，因此宿主接线必须先于页面启用。

import en from "./locales/en/sandbox.json";
import zh from "./locales/zh/sandbox.json";

export { SANDBOX_NS } from "./namespace";

/**
 * Sandbox 的 en / zh 文案资源；两份键结构完全一致（缺键会让界面回退显示 key，
 * 由 `web/__tests__/sandbox-i18n.test.ts` 守护）。
 */
export const sandboxResources = { en, zh } as const;

export type SandboxResources = typeof sandboxResources;
