import { agentSiteApp } from "@fenix/agent-config/db";
import type { ResourceRegistration } from "@fenix/platform-sdk";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * 站点 App（`agent_site_app`）的资源注册：语义定义 + 物理绑定。
 *
 * **归属模式是 `organization`**：站点归属组织（`organization_id`），创建者记在 `user_id`（owner 列）。
 * 由此平台产出两条事实：读范围是"同组织成员"（`memberDefaultActions` 含 `read`），写动作归组织
 * 的 `owner` / `admin`（§5.3）。
 *
 * **为什么 `memberDefaultActions` 能含 `read`，而站点自己的 `visibility` 不进注册**：站点表 `visibility`
 * 的四值（`private` / `org` / `authenticated` / `public`）是**站点自己的发布范围**，决定谁可以访问对外部署
 * 的站点（§3.3「匿名访问由 Site 等资源专属发布字段或发布实体表达」）；平台受众列只有 `private` /
 * `public` 两值（`ResourceVisibility`），且以资源行为单位，`org` / `authenticated` 在平台模型里没有对应
 * 取值。两个 `private` 因此不是同一件事，同一个列不能同时承担"发布范围"与"平台受众"两种语义。
 *
 * 声明该列的真实代价（2026-09-24 实测校正：并非"绑定即越权"）：`publicDefaultActions` 为空时，多声明一个
 * `visibility` 列产出的读谓词与当前**逐字相同**——谓词编译器只在 `publicDefaultActions` 含本次动作时才追加
 * `visibility = 'public'` 分支（`@fenix/access-control` 的 `query/build-predicate.ts`），组织分支只看
 * `organization_id`、不看行的 `visibility`，所以同组织成员的读范围既不缩小也不放大。代价出现在那之后：
 * 一旦 `publicDefaultActions` 非空（或 EE 授权实现按 `ResourceScope.visibility` 判受众），站点的发布范围
 * 就会被平台当作受众范围读——`scopeOfRow` 把非 `public` 取值一律折叠成 `private`，
 * `ColumnResourceScopeStore.update` 还会把该列当公开受众改写，而站点行带 `platform_token`，
 * 跨组织可读即凭据泄漏。
 *
 * 因此本注册**只声明列中的归属列**（`id` / `organizationId` / `ownerUserId`），不声明 `visibility`：
 * 该资源在平台受众模型里没有公开受众（范围恒为 `private`），既不放大也不缩小同组织范围；发布范围的
 * 读过滤由 `facades/agent-site-app-facade.ts` 与 `services/agent-site-app-service.ts` 作为业务条件声明
 * （与平台谓词 AND 后下推为同一条 SQL，读口径的按行判定见 `__tests__/agent-site-app-service.test.ts`）。
 * 这条取舍的完整理由与后续演进方向记录在整改回报中。
 *
 * 与 Skill / MCP Server / AgentConfig 的注册同形的部分：受控资源的语义只有一份（归属模式 + 动作上限 +
 * 成员默认动作 + 公开默认动作），资源包只声明语义与列，授权判断与 SQL 由注入的 `AccessControlModule`
 * 产出。
 */

/** 受控资源类型：站点 App（`agent_site_app`）。 */
export const AGENT_SITE_APP_RESOURCE_TYPE = "agent_site_app";

export const agentSiteAppResource = {
  definition: {
    type: AGENT_SITE_APP_RESOURCE_TYPE,
    ownershipMode: "organization",
    actions: ["read", "create", "update", "delete"],
    memberDefaultActions: ["read"],
    /** 无平台级公开受众：站点发布范围不扩大资源行受众（见文件头）。 */
    publicDefaultActions: [],
  },
  storage: {
    resourceType: AGENT_SITE_APP_RESOURCE_TYPE,
    table: agentSiteApp,
    columns: {
      id: agentSiteApp.id,
      organizationId: agentSiteApp.organizationId,
      ownerUserId: agentSiteApp.userId,
    },
  },
} satisfies ResourceRegistration<typeof agentSiteApp, PgColumn>;
