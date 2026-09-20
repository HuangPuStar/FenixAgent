// web/i18n/index.ts
// Skill 命名空间的文案资源出口（计划 §4：键的最终所在地 = 包的 owner）。
//
// 字典文件留在既有路径 `locales/<lng>/skills.json`：它们是本模块的 import 目标，路径漂移会让本出口
// 在启动期解析失败。宿主 `apps/web/src/i18n/index.ts:22` 经子路径 `@fenix/resource-skill/web/i18n`
// 取 `SKILL_NS` + `skillResources`（正是沙盒的写法），不再按深相对路径读包内 JSON——因此这里只
// **转出**既有字典，不搬动它们，宿主对本包的依赖面收敛为这个出口。
//
// 子路径不是 `./web` 根入口：宿主 i18n 模块在应用启动时求值，从根入口导入会把整个技能页面图（页面、
// Radix 组件、api client）拉进首屏 bundle。未注册时 i18next 回退为 key 回显，因此宿主接线必须先于
// 页面启用。

import en from "./locales/en/skills.json";
import zh from "./locales/zh/skills.json";

export { SKILL_NS } from "./namespace";

/**
 * Skill 的 en / zh 文案资源；两份键结构完全一致（缺键会让界面回退显示 key，
 * 由 `web/__tests__/skill-i18n.test.ts` 守护）。
 */
export const skillResources = { en, zh } as const;

export type SkillResources = typeof skillResources;
