// web/shell/contribution.ts
// 资源包与 WebShell 之间的**浏览器侧**贡献契约（§1.6 T11 定稿）。
//
// 为什么契约落 `@fenix/web-runtime`：与 §1.6 T7 的 org/session 契约同一判据——它是浏览器运行时
// 基础设施包，宿主与全部资源包的 web 面都已依赖它（依赖矩阵里它是 `standalone`，任何类别都允许
// 依赖），而它自己不依赖任何 `@fenix/*` 业务包。契约放在资源包里会让其余包反向依赖那个包。
//
// 为什么**不**复用 `@fenix/platform-sdk` 的 `WebContribution<TValue>`：那一层是**服务端装配**
// 契约（`profile.web` 选择列表 → registry 解析 → `bootstrap.webContributions`），它的值会沿
// registry 进入 server 编译图；本文件的载荷携带 React 组件（导航图标），写进 manifest 就会把浏览器
// 依赖拖进服务端装配图（§1.6 用户裁定：浏览器产物独立于 server registry）。两者是同一概念的
// 两侧：server 侧选择「哪些 web 模块参与装配」，浏览器侧承载「装配什么」。
//
// 导航入口同时作为装配能力的路径归属；非导航入口以 routePrefixes 补充，统一由 Shell 拦截。
// 页面本体仍走 TanStack 文件路由，不在运行期注入路由。

import type { LucideIcon } from "lucide-react";

/**
 * 一个可出现在控制台侧栏的导航项。
 *
 * `id` 同时是三件事的键：路由目标（Shell 组装 `/agent/<id>`）、运行时裁剪键（宿主
 * `sidebarConfigApi` 的 `hiddenTabs` 按它比对）、以及项的唯一标识（同一批贡献里重复即构建期报错）。
 */
export interface WebNavigationItem {
  readonly id: string;
  /**
   * 所属分组的 ID。**分组定义与组间顺序由 Shell 持有**，包只声明自己属于哪一组、组内排第几：
   * 全局布局属于应用壳，资源模块不得反向决定（standards §4.1）。
   */
  readonly groupId: string;
  /**
   * 组内顺序，小者在前。**同组内必须唯一**：`order` 是组内唯一排序键，重复即 Shell 装配期报错。
   *
   * 没有「同值兜底」规则可选——导航项不携带包身份，产物顺序又只是 profile 的 `web` 列表顺序，
   * 拿它兜底等于让版式随装配清单变化（判定见 `apps/web/src/shell/shell-navigation.ts`）。
   */
  readonly order: number;
  /**
   * 文案 key 与它所属的 i18n 命名空间。
   *
   * 字典 owner 是**贡献方本包**（`<pkg>/web/i18n`）：导航项的文案随项一起下沉，宿主不再维护
   * 一份「各模块导航文案」的中央字典。宿主 i18n 已集中注册各包字典（§1.6 T9a），因此 Shell 侧
   * 用 `t(labelKey, { ns })` 即可取到译文，不需要额外接线。
   */
  readonly labelKey: string;
  readonly ns: string;
  readonly icon: LucideIcon;
}

/** 一个包向 WebShell 贡献的浏览器面能力。目前只有导航。 */
export interface WebAppContribution {
  readonly navigation?: readonly WebNavigationItem[];
  /** 非导航入口的路径前缀；导航入口及子路径由 Shell 自动派生，额外页面在 owner 处声明。 */
  readonly routePrefixes?: readonly string[];
}
