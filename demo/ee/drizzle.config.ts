/** EE 只列出自己拥有的 schema，因此只生成 EE DDL。 */
export default {
  schema: ["./packages/resources/enterprise-agent-config/db/schema.ts"],
  out: "./db/migrations",
  dialect: "postgresql",
};
