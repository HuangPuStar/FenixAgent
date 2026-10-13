// web/i18n/index.ts
// Identity 四个命名空间（apikey / login / orgs / settings）的文案资源出口（计划 §4：键的最终所在地 = 包的 owner）。
//
// 字典落在本模块的 import 目标 `locales/{en,zh}/*.json`：路径漂移会让本出口在启动期解析失败。
// 宿主 `apps/web/src/i18n/index.ts` 经子路径 `@fenix/identity/web/i18n` 取
// `APIKEY_NS` / `LOGIN_NS` / `ORGS_NS` / `SETTINGS_NS` 与四个 resources 对象——**这是本包字典的唯一对外读取路径**：
// 收敛前宿主按深相对路径读 `packages/platform/identity/web/i18n/{en,zh}/*.json`，
// 那是一条把宿主绑到包内文件布局的隐式契约，包内改目录不会触发任何门禁。
//
// 子路径而非 `./web` 根入口：宿主 i18n 模块在应用启动时就求值，从根入口导入会把整个控制台
// 身份页面图（组织页、Radix 组件、better-auth 客户端）拉进首屏 bundle。未注册时 i18next
// 回退为 key 回显，因此宿主接线必须先于页面启用。
//
// 一个出口承载四个命名空间而不是拆成四个子路径：四者同属身份域的键，宿主用一段 import 登记完，
// 少一次「新增命名空间忘了加子路径导出」的机会。字典文件名与命名空间字面量同名（`apikey.json`
// ↔ `apikey`、`login.json` ↔ `login`、`orgs.json` ↔ `orgs`、`settings.json` ↔ `settings`），由
// `web/__tests__/identity-i18n.test.ts` 守护。
//
// `settings.json` 两份由 T9 从宿主 `git mv` 进来（`ChangePasswordDialog` 是唯一消费方）；搬迁只改
// 物理落点与注册方，译文逐字未变。`login.json` 两份由「无阻塞批」（登录簇归位）同款迁入——登录页
// 与它的本地组件是这两个文件的全部消费方，随页面一并归位；宿主 `hostResources` 的 `login` 条目
// 与 `./locales/<lang>/login.json` 同批删除。

import apikeyEn from "./locales/en/apikey.json";
import loginEn from "./locales/en/login.json";
import orgsEn from "./locales/en/orgs.json";
import settingsEn from "./locales/en/settings.json";
import apikeyZh from "./locales/zh/apikey.json";
import loginZh from "./locales/zh/login.json";
import orgsZh from "./locales/zh/orgs.json";
import settingsZh from "./locales/zh/settings.json";

export { APIKEY_NS, LOGIN_NS, ORGS_NS, SETTINGS_NS } from "./namespace";

/**
 * API Key 页的 en / zh 文案资源；两份键结构完全一致（缺键会让界面回退显示 key，
 * 由 `web/__tests__/identity-i18n.test.ts` 守护）。
 */
export const apikeyResources = { en: apikeyEn, zh: apikeyZh } as const;

/** 登录/注册页的 en / zh 文案资源，与 `apikeyResources` 同款约束。 */
export const loginResources = { en: loginEn, zh: loginZh } as const;

/** 组织与成员页的 en / zh 文案资源，与 `apikeyResources` 同款约束。 */
export const orgResources = { en: orgsEn, zh: orgsZh } as const;

/** 账户设置（修改密码对话框）的 en / zh 文案资源，与 `apikeyResources` 同款约束。 */
export const settingsResources = { en: settingsEn, zh: settingsZh } as const;

export type ApikeyResources = typeof apikeyResources;
export type LoginResources = typeof loginResources;
export type OrgResources = typeof orgResources;
export type SettingsResources = typeof settingsResources;
