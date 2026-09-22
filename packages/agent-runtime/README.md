# Agent Runtime

`@fenix/agent-runtime` 是 Environment、Instance、Runtime、relay、ACP session、Chat 与 YJS 的单一 workspace package 边界。这些能力共同组成有状态 Agent 运行子系统，不按运行阶段拆分 package。

assembly 使用 `agentRuntime` 槽位，以及稳定 module ID 和 module kind `agent-runtime`。包内可按职责组织目录，但不得将 Instance、Chat 或 YJS 等职责拆成独立 workspace package；跨包调用只使用公开 exports 和启动端口。

## 表定义与边界残留

- **本包持有两张表（§1.7 B8，2026-09-22）**：`environment`（运行环境）、`agent_instance`（持久实例）与
  `agentInstanceCreationSourceEnum` 的定义随 B8 从宿主 `apps/server/src/db/schema.ts` 迁到本包
  `db/schema.ts`（出口 `@fenix/agent-runtime/db`，`drizzle.config.ts` 已声明本包 schema 路径，DDL 逐字保留、
  `bun run check:schema-ddl-drift` 零差异）。包内 6 个文件（5 个生产 + 1 个用例）的取表点随之改指本包出口，
  宿主 `schema.ts` 改为导入该出口以维持 `im_channel_route.environment_id` 的外键表达（该 FK 随 B13 迁出）。
  `src/server/db.ts` 的句柄类型 `AgentRuntimeDatabase` 刻意不写 `typeof schema`，因此迁表未改形状。
- **两条跨包外键，都只在组装期导入列对象**：`environment.agent_config_id → agent_config.id`（owner
  `@fenix/agent-config`）与两张表的 `user_id` / `owner_user_id` / `created_by_user_id → user.id`（owner
  `@fenix/identity`）。`package.json` 为此新增 `@fenix/identity` 声明（`@fenix/agent-config` 此前已在）；
  `.dependency-cruiser.cjs` 的 `agent-runtime-not-to-resources` 已显式豁免 `db/**`，本文件是其唯一合法落点，
  `src/**` 侧的反向禁则不变（本包读 Agent 配置只经宿主注入的 `AgentConfigLookupPort`）。
- **跨包取数入口（§1.7 B8）**：`./server/environment` 出口新增两个只服务 `@fenix/agent-config` 删除 / 重启
  编排的入口——`listEnvironmentIdsByAgentConfig`（只取 id）与 `deleteEnvironmentsByAgentConfig(tx, {...})`
  （在**调用方事务**内删环境行，两个包的句柄类型同为 `NodePgDatabase<Record<string, never>>`）。两者都不做
  授权（调用方 Facade 已判 `delete` / `use`），归属条件同时收 `organization_id` 与 `agent_config_id`。
- **`@server/**` 生产侧已归零**：B8 前生产侧有 5 处 `@server/db/schema` 表定义导入，随两张表迁出全部消失。
  实测 `grep -rnE 'from "@server/' packages/agent-runtime/src packages/agent-runtime/web
  packages/agent-runtime/fenix.module.ts | grep -v __tests__` → **0 条 / 0 文件**（注释里点名的宿主路径不计）。
  测试侧仍有 17 处宿主测试基建耦合（`@server/test-utils/stubs/module-stubs` 16 处 +
  `@server/plugins/error-handler` 1 处），不随表定义迁出消失，架构例外台账的
  `apps-boundary @fenix/agent-runtime → @fenix/server-app` 条目因此继续保留。
