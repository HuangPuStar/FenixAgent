import { user } from "@fenix/identity/db";
import { sql } from "drizzle-orm";
import { index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * Provider / Model / 模型网关凭证的 schema 唯一真相来源。
 *
 * 三张表的迁移链历史 DDL 原样保留，只搬定义位置：表名、列名、默认值、索引名都不得顺手改动，否则
 * `bun run db:generate` 会产出非空迁移（由 `bun run check:schema-ddl-drift` 门禁强制）。
 *
 * **三个 `pgEnum` 随表迁入**（本仓 owner 包持有枚举的首例）：`provider_protocol` / `provider_kind` /
 * `model_gateway_credential_status` 的消费者只有这里的三个列，定义留宿主会让本文件反向 import 宿主，
 * 方向不成立；在包内重定义一份则会让 `check:schema-ddl-drift` 直接报差异。
 *
 * `user` 是唯一的跨包外键目标：身份表归 `@fenix/identity/db`（任务 1.2），这里只导入表对象表达
 * `provider.user_id` 的级联删除，不复制定义。`model.provider_id` 指向同文件的 `provider`，因此本文件
 * 不需要导入第二个跨包表对象。跨模块外键的组装期例外口径见
 * `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §6.1。
 *
 * `agent_config.model_id` 的外键由宿主经 `@fenix/model-management/db` 表达；`model_gateway_credential`
 * 的三条关联列（`gateway_provider_id` / `user_id` / `agent_config_id`）历史 DDL 上就没有外键约束，
 * 关联由应用层（本包仓储）维护，本次照原样保留。
 */

/** Provider 的协议族；决定请求体的方言转换。 */
export const providerProtocolEnum = pgEnum("provider_protocol", ["openai", "anthropic"]);

/** Provider 的接入方式：直连上游，或经模型网关转发。 */
export const providerKindEnum = pgEnum("provider_kind", ["direct", "gateway"]);

/** 网关凭证的可用状态；`blocked` 表示上游拒绝、`error` 表示回收或换发失败。 */
export const modelGatewayCredentialStatusEnum = pgEnum("model_gateway_credential_status", [
  "active",
  "blocked",
  "error",
]);

/** AI 服务商：受控资源主表，`visibility` 是授权实现的唯一公开受众声明。 */
export const provider = pgTable(
  "provider",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    name: varchar("name").notNull(),
    displayName: varchar("display_name"),
    kind: providerKindEnum("kind").notNull().default("direct"),
    gatewayType: varchar("gateway_type"),
    protocol: providerProtocolEnum("protocol").notNull().default("openai"),
    baseUrl: text("base_url"),
    apiKey: text("api_key"),
    extraOptions: jsonb("extra_options"),
    // 资源可见范围：授权实现的唯一公开受众声明（public 对任意已认证主体开放公开默认动作）。
    visibility: varchar("visibility", { length: 20 }).notNull().default("private"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameIdx: uniqueIndex("idx_provider_org_name").on(table.organizationId, table.name),
    orgVisibilityIdx: index("idx_provider_org_visibility").on(table.organizationId, table.visibility),
  }),
);

/** AI 模型（原 `provider.models` 子对象）：可见性与可写性完全继承 Provider，不注册独立资源。 */
export const model = pgTable(
  "model",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => provider.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    modelId: varchar("model_id").notNull(),
    displayName: varchar("display_name"),
    modalities: jsonb("modalities"),
    limitConfig: jsonb("limit_config"),
    cost: jsonb("cost"),
    options: jsonb("options"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerModelIdx: uniqueIndex("idx_model_provider_model").on(table.providerId, table.modelId),
    orgModelIdx: uniqueIndex("idx_model_org_provider_model").on(table.organizationId, table.providerId, table.modelId),
  }),
);

/** 模型网关凭证映射：远端 Key 回收后删除，使恢复授权时可安全换发新 Key。 */
export const modelGatewayCredential = pgTable(
  "model_gateway_credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gatewayProviderId: uuid("gateway_provider_id").notNull(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    agentConfigId: uuid("agent_config_id").notNull(),
    externalCredentialId: text("external_credential_id").notNull(),
    encryptedCredential: text("encrypted_credential"),
    status: modelGatewayCredentialStatusEnum("status").notNull().default("active"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    subjectIdx: uniqueIndex("idx_model_gateway_credential_subject").on(
      table.gatewayProviderId,
      table.organizationId,
      table.userId,
      table.agentConfigId,
    ),
    externalIdIdx: index("idx_model_gateway_credential_external_id").on(table.externalCredentialId),
    statusIdIdx: index("idx_model_gateway_credential_status_id").on(table.status, table.id),
  }),
);
