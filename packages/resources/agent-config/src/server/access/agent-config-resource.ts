import { agentConfig } from "@fenix/agent-config/db";
import type { ResourceRegistration } from "@fenix/platform-sdk";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * AgentConfig 的资源注册：语义定义 + 物理绑定。
 *
 * 归属列直接在主表（`organization_id` / `user_id` / `visibility`），因此创建期归属由
 * `AccessControlModule.resolveInitialScope` 解析后与 INSERT 同批写入，不需要 side-table 初始化。
 *
 * 动作收敛（决策 D1）：member 只拿到 `read` / `use`，创建、修改、删除与公开受众设置属于 owner
 * 与 admin。`use` 保留给"运行/重启该 Agent 实例"这类操作性动作，与迁移前的"组织内成员可写"相比，
 * 收紧的是配置写入而非运行操作。
 *
 * `publicDefaultActions` 只放大读范围：其他组织拿到的是只读副本，不提升任何写权限。
 *
 * 与 Skill / MCP Server 的注册同形是刻意的：受控资源的语义只有一份（归属模式 + 动作上限 + 成员
 * 默认动作 + 公开默认动作），资源包只声明这份语义与列，授权判断与 SQL 由注入的
 * `AccessControlModule` 产出。
 */

/** 受控资源类型；与旧 `resource_permission.resource_type` 的取值一致（S6 删除旧表）。 */
export const AGENT_CONFIG_RESOURCE_TYPE = "agent_config";

export const agentConfigResource = {
  definition: {
    type: AGENT_CONFIG_RESOURCE_TYPE,
    ownershipMode: "organization",
    actions: ["read", "create", "update", "delete", "use"],
    memberDefaultActions: ["read", "use"],
    publicDefaultActions: ["read"],
  },
  storage: {
    resourceType: AGENT_CONFIG_RESOURCE_TYPE,
    table: agentConfig,
    columns: {
      id: agentConfig.id,
      organizationId: agentConfig.organizationId,
      ownerUserId: agentConfig.userId,
      visibility: agentConfig.visibility,
    },
  },
} satisfies ResourceRegistration<typeof agentConfig, PgColumn>;
