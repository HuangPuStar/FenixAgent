import type { ResourceRegistration } from "@fenix/platform-sdk";
import { skill } from "@server/db/schema";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Skill 的资源注册：语义定义 + 物理绑定。
 *
 * 归属列直接在主表（`organization_id` / `user_id` / `visibility`），因此创建期归属由
 * `AccessControlModule.resolveInitialScope` 解析后与 INSERT 同批写入，不需要 side-table 初始化。
 *
 * 动作收敛（决策 D1）：member 只拿到 `read` / `use`，创建、修改、删除与公开受众设置属于 owner
 * 与 admin；`public` 只放大读范围，不提升写权限。
 *
 * 与 MCP Server 的注册同形是刻意的：受控资源的语义只有一份（归属模式 + 动作上限 + 成员默认动作 +
 * 公开默认动作），资源包只声明这份语义与列，授权判断与 SQL 由注入的 `AccessControlModule` 产出。
 * Skill 的**内容**在文件系统、归档在 SKILL.md 同级目录，这些都不属于资源归属语义，因此不出现在注册里。
 */

/** 受控资源类型；与旧 `resource_permission.resource_type` 的取值一致（S6 删除旧表）。 */
export const SKILL_RESOURCE_TYPE = "skill";

export const skillResource = {
  definition: {
    type: SKILL_RESOURCE_TYPE,
    ownershipMode: "organization",
    actions: ["read", "create", "update", "delete", "use"],
    memberDefaultActions: ["read", "use"],
    publicDefaultActions: ["read"],
  },
  storage: {
    resourceType: SKILL_RESOURCE_TYPE,
    table: skill,
    columns: {
      id: skill.id,
      organizationId: skill.organizationId,
      ownerUserId: skill.userId,
      visibility: skill.visibility,
    },
  },
} satisfies ResourceRegistration<typeof skill, PgColumn>;
