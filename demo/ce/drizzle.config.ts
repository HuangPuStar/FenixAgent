/** Drizzle 只读取模块 schema 文件；这里不是第二份 schema。 */
export default {
  schema: ["./packages/resources/agent-config/db/schema.ts"],
  out: "./db/migrations",
  dialect: "postgresql",
};
