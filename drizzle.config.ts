import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // 身份表的 schema 归属 `@fenix/identity/db`（CE 阶段 2 任务 1.2），其余表仍在 apps/server。
  // 迁移链是两者共同的产物，因此这里必须同时声明，否则 `db:generate` 会误判身份表已删除。
  schema: ["./apps/server/src/db/schema.ts", "./packages/platform/identity/db/schema.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgres://rcs:rcs@localhost:5432/rcs",
  },
});
