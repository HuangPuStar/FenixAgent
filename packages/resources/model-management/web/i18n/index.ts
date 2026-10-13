// Model-management 命名空间的文案资源出口（计划 §4：键的最终所在地 = 包的 owner）。
//
// 本包原先没有自己的 i18n 目录，三批键分别寄居在别处，本次一并收回：
//
// 1. `models` 命名空间（宿主 `apps/web/src/i18n/locales/{en,zh}/models.json`，41 组 / 200 叶子）
//    —— 消费方全部是本包的 Provider/模型页面，宿主与其他包零引用（实测：全仓库除宿主注册行外，
//    没有第二处 `useTranslation("models")` / `NS.MODELS` / `models:` 前缀用法），因此整份字典随
//    owner 迁入本包。
// 2. `observer` 命名空间的 `modelGateway.*` 组（171 叶子）—— 消费方是本包的管理台页面
//    `web/pages/admin/AdminModelGatewayPage.tsx` 与 `ModelGatewayKeyManagementPanel.tsx`；
//    跨包寄居会让「文案 owner」与「字典 owner」分属两个包。迁出后 observer 侧只删除寄居键、
//    不保留副本（该包 `web/__tests__/observer-i18n.test.ts` 已把「不得回流」钉成断言）。
//    取值来源是稳定快照 `git show HEAD:packages/resources/observer/web/i18n/{en,zh}/observer.json`
//    —— observer 包的工作区正在并发改写，不能读工作区文件。
// 3. 宿主 `components` 命名空间的 `modelConfig.*` 组（6 键，组件 `web/components/config/ModelConfigDialog.tsx`
//    专用）随组件归属迁入，并补齐两个宿主字典里长期缺失、组件一直在用（渲染为 key 回显）的键：
//    `updateSuccess` / `updateError`。
//
// 另有两个由本包管理页使用的 observer 键（`login.error`、`states.loading`）**不整体搬迁**：这两组归
// observer 所有且被 observer/sandbox 的管理页共享，只按本包语义复制字符串为 `admin.gateAuthFailed`
// 与 `admin.loading`（值逐字一致，UI 文案不变）。
//
// 宿主注册方式（共享文件 `apps/web/src/i18n/index.ts`）：从子路径
// `@fenix/model-management/web/i18n` 导入本模块，把 `modelManagementResources.en/zh` 登记到
// `MODELS_NS`。**切换已落盘**（2026-09-20 复核：该文件 `:14` 取 `MODELS_NS` /
// `modelManagementResources`，`:115,:129` 登记到 `NS.MODELS`，宿主本地副本
// `apps/web/src/i18n/locales/{en,zh}/models.json` 已删除），宿主生效的字典只剩本包这一份。原先记录的
// 「包切片不能写 `apps/**`，故切换属编排者 patch」是切换前的状态，属历史。
// 子路径而非 `./web` 根入口：宿主 i18n 模块在应用启动时就求值，从根入口导入会把整个模型管理页面图
// （页面、Radix 组件、api client、`@lobehub/icons`）拉进首屏 bundle。未注册时 i18next 回退为 key
// 回显，因此宿主接线必须先于页面启用。

import en from "./locales/en/models.json";
import zh from "./locales/zh/models.json";

export { MODELS_NS } from "./namespace";

/**
 * Provider / Model / 模型网关的 en / zh 文案资源；两份键结构完全一致（缺键会让界面回退显示 key，
 * 由 `web/__tests__/model-management-i18n.test.ts` 守护）。
 */
export const modelManagementResources = { en, zh } as const;

export type ModelManagementResources = typeof modelManagementResources;
