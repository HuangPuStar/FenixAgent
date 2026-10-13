// web/i18n/index.ts
// ProdView 命名空间的文案资源出口（计划 §4：键的最终所在地 = 包的 owner）。
//
// 本包自持 `prodViews` 命名空间：`modules.*` 与页面级键已在包内，本次把寄居在宿主
// `apps/web/src/i18n/locales/{en,zh}/components.json` 的 `panelMode.views*` 键组收敛为 `panel.*`
// 引入本包。跨包寄居会让文案 owner 与消费方分属两侧——宿主某个任务清理该组时界面只会静默回退为
// key 回显。迁出后宿主侧那批键只删除、不保留副本（见交付说明的 sharedPatches）。
//
// 目录布局 `i18n/locales/{en,zh}/prodViews.json` 与黄金样本 sandbox 一致（计划 §4 的目标态）：
// 宿主已登记按深相对路径导入的旧路径（`web/i18n/{en,zh}/prodViews.json`），本次迁移后宿主注册必须
// 同批切到子路径导入（见交付说明的宿主 patch 清单），否则启动即解析失败。
//
// 宿主注册方式：从子路径 `@fenix/resource-prod-view/web/i18n` 导入本模块，把
// `prodViewsResources.en/zh` 登记到 `PROD_VIEWS_NS`。用子路径而非 `./web` 根入口，是因为宿主 i18n
// 模块在应用启动时求值，从根入口导入会把整张页面图（页面、Radix 组件、api client）拉进首屏 bundle。
// 未注册时 i18next 回退为 key 回显，因此宿主接线必须先于页面启用。

import en from "./locales/en/prodViews.json";
import zh from "./locales/zh/prodViews.json";

export { PROD_VIEWS_NS } from "./namespace";

/**
 * ProdView 的 en / zh 文案资源。两份键结构必须逐字一致：缺键的语言会静默显示 key 本身，
 * 由 `web/__tests__/prod-view-i18n.test.ts` 守护。
 */
export const prodViewsResources = { en, zh } as const;

export type ProdViewsResources = typeof prodViewsResources;
