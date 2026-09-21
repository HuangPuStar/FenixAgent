import type { ResourceRegistration } from "@fenix/platform-sdk";
import { mcpServer } from "@fenix/resource-mcp/db";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * MCP Server 的资源注册：语义定义 + 物理绑定。
 *
 * 归属列直接在主表（`organization_id` / `user_id` / `visibility`），因此创建期归属由
 * `AccessControlModule.resolveInitialScope` 解析后与 INSERT 同批写入，不需要 side-table 初始化。
 *
 * 动作收敛（决策 D1）：member 只拿到 `read` / `use`，创建、修改、删除与公开受众设置属于 owner
 * 与 admin；`public` 只放大读范围，不提升写权限。资源包只声明这份语义与列，授权判断与 SQL 由
 * 注入的 `AccessControlModule` 产出。
 */

/** 受控资源类型；与旧 `resource_permission.resource_type` 的取值一致（S6 删除旧表）。 */
export const MCP_SERVER_RESOURCE_TYPE = "mcp_server";

export const mcpServerResource = {
  definition: {
    type: MCP_SERVER_RESOURCE_TYPE,
    ownershipMode: "organization",
    actions: ["read", "create", "update", "delete", "use"],
    memberDefaultActions: ["read", "use"],
    publicDefaultActions: ["read"],
  },
  storage: {
    resourceType: MCP_SERVER_RESOURCE_TYPE,
    table: mcpServer,
    columns: {
      id: mcpServer.id,
      organizationId: mcpServer.organizationId,
      ownerUserId: mcpServer.userId,
      visibility: mcpServer.visibility,
    },
  },
} satisfies ResourceRegistration<typeof mcpServer, PgColumn>;
