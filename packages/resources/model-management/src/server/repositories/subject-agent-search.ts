import { searchAgentConfigsSystem } from "@fenix/agent-config/server";
import type { ApiSystemPagination } from "@fenix/platform-sdk";

/**
 * 模型网关预算主体选择器的 Agent 检索（只读）：协议分页 → `@fenix/agent-config` 的 `limit/offset` 薄适配层。
 *
 * 检索 SQL 已随 §1.7 B7 归 owner 包：`agent_config` 表定义迁到 `packages/resources/agent-config/db/schema.ts`，
 * 全局分页检索由 `@fenix/agent-config/server` 的 `searchAgentConfigsSystem`（`AgentConfigSystemSearchInput` /
 * `AgentConfigSystemSearchRow`）承担。本文件因此不再持有表对象、drizzle 条件构造与 DB 句柄，只保留两件本包
 * 自己的东西：`/api/system/model-gateway/*` 的协议分页口径（`page` 从 1 起 → `offset`），以及给
 * `subject-service.ts` 注入的对外类型与函数形状。
 *
 * 为什么不直接把 `searchAgentConfigsSystem` 交给调用方：本包消费的是**协议的** `{ page, pageSize }`
 * （`ApiSystemPagination`，`packages/platform/platform-sdk/src/protocol/system-api.ts` 里 `page` 为
 * `min(1).default(1)`，从 1 起），owner 侧收的是已换算的 `limit/offset`。换算与「page 从 1 起」这条协议
 * 约定属于本包的路由契约，不下沉到 owner。
 */
export interface ModelGatewaySubjectAgent {
  id: string;
  name: string;
  organizationId: string;
  userId: string;
}

/** 检索条件与分页；查询串由路由解析后传入，分页换算在本层完成。 */
export interface SubjectSearchInput extends ApiSystemPagination {
  keyword?: string;
  organizationId?: string;
  userId?: string;
}

/**
 * 按条件分页检索 Agent 配置；无条件时返回全表第一页（系统管理面的预期行为）。
 *
 * 过滤语义（含 `organizationId` / `userId` 的 `ilike`、`keyword` 的 `trim` 与 name/id 双匹配）随 DDL 一并
 * 归 owner，本层只做分页换算；细则与保留原因见 `searchAgentConfigsSystem` 的注释。
 */
export async function searchAgentConfigs(input: SubjectSearchInput): Promise<ModelGatewaySubjectAgent[]> {
  return searchAgentConfigsSystem({
    keyword: input.keyword,
    organizationId: input.organizationId,
    userId: input.userId,
    limit: input.pageSize,
    offset: (input.page - 1) * input.pageSize,
  });
}
