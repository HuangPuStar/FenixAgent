import type { ResourceRegistration } from "@fenix/platform-sdk";
import { pluginMarketPackage } from "@fenix/resource-plugin-market/db";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * 插件市场条目的资源注册：语义定义 + 物理绑定。
 *
 * 归属列直接在主表（`organization_id` / `owner_user_id` / `visibility`），因此创建期归属由
 * `resolveInitialScope` 解析后与 INSERT 同批写入，不需要 side-table 初始化。
 *
 * **这份定义同时表达「平台全局目录」**，没有任何一条是针对单个组织的：
 * - `publicDefaultActions: ["read"]` 叠加 `visibility = 'public'`，让**任意已认证主体**（含无 active
 *   organization 的）都能读——这是本仓库唯一能让「所有已认证用户可读」成立的机制，它不依赖 actor 条件。
 * - `memberDefaultActions: ["read"]`：普通成员只读，不因「同组织」而获得写权。
 * - 写权（create / update / delete）只落在**归属组织的 owner / admin** 上。归属组织固定为系统托管租户
 *   （身份表里 `slug = 'admin'` 的那个），因此实际上只有平台系统管理员能发布、下架与恢复。
 *
 * 代价要说清：这**不是**一等语义的「平台级资源」——授权模块只知道「系统租户的这个资源」。等出现第二个
 * 独立的全局目录、或需要把市场从任何组织叙事里摘出去时，才值得给 `@fenix/access-control` 加一个
 * `platform` ownershipMode；本模块不为那一天提前改造平台核心。
 */

/** 受控资源类型：市场条目（一个 NPM package 的市场身份）。 */
export const PLUGIN_MARKET_PACKAGE_RESOURCE_TYPE = "plugin_market_package";

export const pluginPackageResource = {
  definition: {
    type: PLUGIN_MARKET_PACKAGE_RESOURCE_TYPE,
    ownershipMode: "organization",
    actions: ["read", "create", "update", "delete"],
    memberDefaultActions: ["read"],
    publicDefaultActions: ["read"],
  },
  storage: {
    resourceType: PLUGIN_MARKET_PACKAGE_RESOURCE_TYPE,
    table: pluginMarketPackage,
    columns: {
      id: pluginMarketPackage.id,
      organizationId: pluginMarketPackage.organizationId,
      ownerUserId: pluginMarketPackage.ownerUserId,
      visibility: pluginMarketPackage.visibility,
    },
  },
} satisfies ResourceRegistration<typeof pluginMarketPackage, PgColumn>;
