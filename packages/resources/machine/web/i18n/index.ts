// web/i18n/index.ts
// Machine 命名空间的文案资源出口（键的最终所在地 = 包的 owner）。
//
// 宿主注册方式（已落地，apps/web/src/i18n/index.ts）：从子路径 `@fenix/resource-machine/web/i18n`
// 导入本模块，把 `machineResources.en/zh` 登记到 `MACHINE_NS`。为什么走子路径而不是 `./web` 根入口：
// 宿主 i18n 模块在应用启动时就求值，从根入口导入会把 web 面（fs 客户端、上传 hook）一并拉进首屏 bundle。
// 未注册时 i18next 回退为 key 回显，因此宿主接线必须先于消费方启用。
//
// 自持键的来源：文件上传 hook（`web/hooks/use-file-uploads`）2026-09-24 随文件域实现迁入本包
// （台账 `ce-standards-todo.md` D2），它的文案从宿主 `components` 字典一并迁出——键的消费方只剩该
// hook，因此键随实现换 owner。JSON 路径是包自身的契约（`web/__tests__/machine-i18n.test.ts` 钉住
// `locales/` 形状），宿主不得按相对路径取。

import en from "./locales/en/machine.json";
import zh from "./locales/zh/machine.json";

export { MACHINE_NS } from "./namespace";

/**
 * Machine 的 en / zh 文案资源；两份键结构完全一致（缺键会让界面回退显示 key，由
 * `web/__tests__/machine-i18n.test.ts` 守护）。
 */
export const machineResources = { en, zh } as const;

export type MachineResources = typeof machineResources;
