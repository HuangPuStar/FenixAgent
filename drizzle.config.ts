import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // 已迁出的表按 owner 包声明，其余仍在 apps/server；迁移链是它们共同的产物，必须全部列出，
  // 否则 `db:generate` 会把漏声明的一族误判为已删除。
  // 已迁出：身份表 `@fenix/identity/db`（任务 1.2）、机器表 `@fenix/resource-machine/db`、MCP 表
  // `@fenix/resource-mcp/db`（任务 1.7 B1 / B2）、Provider/Model/网关凭证表 `@fenix/model-management/db`
  // （任务 1.7 B3）、沙盒资源池/实例表 `@fenix/resource-sandbox/db`（任务 1.7 B4）与 Skill 资源行
  // `@fenix/resource-skill/db`（任务 1.7 B5）、Workflow 九张领域表 `@fenix/resource-workflow/db`
  // （任务 1.7 B6）、Agent 配置聚合五张表 `@fenix/agent-config/db`（任务 1.7 B7）、运行环境/实例表
  // `@fenix/agent-runtime/db`（任务 1.7 B8）、知识库三张表 `@fenix/resource-knowledge/db`（任务 1.7 B9）
  // 与 Agent 记忆开关表 `@fenix/resource-memory/db`（任务 1.7 B10）。
  schema: [
    "./apps/server/src/db/schema.ts",
    "./packages/platform/identity/db/schema.ts",
    "./packages/agent-runtime/db/schema.ts",
    "./packages/resources/agent-config/db/schema.ts",
    "./packages/resources/knowledge/db/schema.ts",
    "./packages/resources/machine/db/schema.ts",
    "./packages/resources/mcp/db/schema.ts",
    "./packages/resources/memory/db/schema.ts",
    "./packages/resources/model-management/db/schema.ts",
    "./packages/resources/skill/db/schema.ts",
    "./packages/resources/sandbox/db/schema.ts",
    "./packages/resources/workflow/db/schema.ts",
  ],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgres://rcs:rcs@localhost:5432/rcs",
  },
});
