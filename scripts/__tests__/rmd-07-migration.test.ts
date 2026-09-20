import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

const RMD_07_MOVES = [
  ["src/routes/web/index.ts", "apps/server/src/routes/web/index.ts"],
  ["src/routes/web/config/index.ts", "apps/server/src/routes/web/config/index.ts"],
  ["src/services/build-info.ts", "apps/server/src/services/build-info.ts"],
  ["src/services/config-utils.ts", "apps/server/src/services/config-utils.ts"],
  ["src/services/config/types.ts", "apps/server/src/services/config/types.ts"],
  ["src/services/core-bootstrap.ts", "apps/server/src/services/core-bootstrap.ts"],
  ["src/services/data-migrate.ts", "apps/server/src/services/data-migrate.ts"],
  [
    "src/services/data-migrates/migrate-agent-config-model-id.ts",
    "apps/server/src/services/data-migrates/migrate-agent-config-model-id.ts",
  ],
  ["src/services/sync-builtin.ts", "apps/server/src/services/sync-builtin.ts"],
  ["src/types/global.d.ts", "apps/server/src/types/global.d.ts"],
  ...[
    "agent-platform-api-reference.test.ts",
    "architecture-check.test.ts",
    "build-info.test.ts",
    "capabilities-coalescing.test.ts",
    "config-integration.test.ts",
    "config-validators.test.ts",
    "data-migrate.test.ts",
    "engine-type-schema.test.ts",
    "error-class-semantics.test.ts",
    "error-handler.test.ts",
    "migrate-agent-config-model-id.test.ts",
    "pagination-bounds.test.ts",
    "peri-task-detail-service.test.ts",
    "phone-signup-route.test.ts",
    "round15-isolated-service-boundaries.test.ts",
    "round16-isolated-protocol-boundaries.test.ts",
    "round18-agent-config-model-migration-boundaries.test.ts",
    "round19-isolated-repository-boundaries.test.ts",
    "round21-isolated-service-coverage.test.ts",
    "round22-launch-spec-isolation.test.ts",
    "round29-cache-isolation.test.ts",
    "round37-service-boundaries.test.ts",
    "round45-auth-plugin.test.ts",
    "round52-agent-model-migration.test.ts",
    "sanitize-execution-log.test.ts",
    "structured-logger.test.ts",
    "task-schema.test.ts",
    "test-openai-chat.sh",
    "workspace-symlink-escape.test.ts",
  ].map((file) => [`src/__tests__/${file}`, `apps/server/src/__tests__/${file}`] as const),
] as const;

/**
 * 已删除的宿主副本，三元组为 `[旧根路径, 宿主路径, 包内 owner 落点]`。
 *
 * 任务 1.3 的三份契约 owner 是 Provider / Model / Machine 资源包，宿主副本在删除前已零消费方
 * （`schemas/index.ts` 不转发）；与包内实现并存会让同一份协议出现两种定义，且分歧只在运行期暴露。
 * 任务 1.4 W2 的三份（`schemas/api-instance.schema.ts`、`services/openai-response-mapper.ts` 及其协议边界测试
 * `__tests__/round18-openai-response-protocol-boundaries.test.ts`）owner 是 agent-runtime：唯一消费方都在该包内，
 * 宿主副本删除后由包内落点承载，`/api/instances` 与 `/api/openai-chat` 的协议定义不再跨包分叉，测试也随
 * 被测模块落到 owner 包内。
 * 任务 1.5c 的五项：`src/routes/hooks.ts`（Webhook 入口）的 owner 是 workflow 资源包——处理器
 * `handleWebhookRequest` 与 trigger 仓储本来就在包内，宿主这份只是路由壳。迁出时一并恢复了自 FND-05
 * （入口迁到 `apps/server/src/main.ts`）起丢失的挂载：该路由在旧入口 `src/index.ts` 上是有 `.use()` 的，
 * 迁移时未带过来，导致 `/hooks/:publicHash` 长期不可达（详细证据见 review/task-1.5-host-aggregation.md §七）。
 * 另两项的 owner 是 agent-runtime：`schemas/session.schema.ts`（会话协议模型）与 `services/transport.ts`
 * （会话事件规范化与发布，迁入后定名 `transport/session-events.ts`）都只被宿主控制面路由消费，而控制面
 * 本身也已迁入该包——宿主副本删除后由包内落点承载，`/web/sessions/:id/*` 的协议定义与事件发布不再跨包。
 * 后三项 owner 同样是 agent-runtime：`routes/web/{instances,environments}.ts`（控制台实例与环境生命周期）
 * 与其宿主测试 `__tests__/web-instance-runtime-actions.test.ts`。两者的 owner 本就在该包（路由只是运行 port
 * 的协议接入层），测试随被测路由落到包内、认证改用包内守卫替身；另有同域用例
 * `__tests__/instances-delete-idempotent.test.ts` 与 `__tests__/round44-environments-routes.test.ts`
 * （不在本表内，随各片一并迁入包内——后者在 `root-source-owner-rules.ts` 中本就按 agent-runtime 登记）。
 * 任务 1.5c 的后两项 owner 是 model-management：`routes/web/peri-task-details.ts`（Peri 任务详情路由）
 * 与 `schemas/peri-task-details.ts`（其协议契约）。两者的 owner 本就在该包——读取逻辑 `getPeriTaskDetail`
 * 与投影存储 `createPeriTaskDetailStore` 在 1.3 已迁入，协议 schema 也在 1.3 归位（宿主这份与包内副本
 * **字节相同**，属 §1.3(1) 明令禁止的 app↔package 重复实现），宿主侧那份只是协议接入壳。按「删除优于
 * 兼容」删除宿主两份副本、owner 落回包内；路由迁入后环境归属校验改由宿主的注入端口提供
 * （`Environment` 表的 owner 是 agent-runtime，依赖矩阵不允许资源包依赖它）。
 * 任务 1.5c 的第九项 owner 是 agent-config：`routes/web/meta-agent.ts`（`POST /web/meta-agent/ensure`）。
 * 查找或创建 meta environment + spawn 实例的编排（`ensureMetaEnvironment`）与响应 schema 本就在该包，
 * 宿主那份只是协议接入壳；迁入后 apiKey 轮换改由工厂依赖注入（资源包不得依赖 `@fenix/identity`）。
 * 任务 1.5c 的第十项 owner 是 identity：`services/config/user-config.ts`（`user_config` 表的读写）。
 * 该表的真相来源本就在 `packages/platform/identity/db/schema.ts`，读写却留在宿主，属「表与它的读写分处
 * 两层」；迁入 `repositories/user-config.ts` 后两者同址（DB 句柄改为 `getIdentityDatabase()`），宿主经
 * 包入口取用（唯一消费者是 `services/resource-module-ports.ts` 的两个偏好端口）。
 */
const RMD_07_RELOCATED = [
  [
    "src/schemas/api-model.schema.ts",
    "apps/server/src/schemas/api-model.schema.ts",
    "packages/resources/model-management/src/server/schemas/api-model.schema.ts",
  ],
  [
    "src/schemas/config.schema.ts",
    "apps/server/src/schemas/config.schema.ts",
    "packages/resources/model-management/src/server/schemas/config.schema.ts",
  ],
  [
    "src/schemas/api-workspace.schema.ts",
    "apps/server/src/schemas/api-workspace.schema.ts",
    "packages/resources/machine/src/schemas/api-workspace.schema.ts",
  ],
  [
    "src/schemas/api-instance.schema.ts",
    "apps/server/src/schemas/api-instance.schema.ts",
    "packages/agent-runtime/src/schemas/api-instance.schema.ts",
  ],
  [
    "src/services/openai-response-mapper.ts",
    "apps/server/src/services/openai-response-mapper.ts",
    "packages/agent-runtime/src/services/openai-response-mapper.ts",
  ],
  [
    "src/__tests__/round18-openai-response-protocol-boundaries.test.ts",
    "apps/server/src/__tests__/round18-openai-response-protocol-boundaries.test.ts",
    "packages/agent-runtime/src/__tests__/round18-openai-response-protocol-boundaries.test.ts",
  ],
  [
    "src/routes/hooks.ts",
    "apps/server/src/routes/hooks.ts",
    "packages/resources/workflow/src/server/routes/hooks/index.ts",
  ],
  [
    "src/schemas/session.schema.ts",
    "apps/server/src/schemas/session.schema.ts",
    "packages/agent-runtime/src/schemas/session.schema.ts",
  ],
  [
    "src/services/transport.ts",
    "apps/server/src/services/transport.ts",
    "packages/agent-runtime/src/transport/session-events.ts",
  ],
  [
    "src/routes/web/instances.ts",
    "apps/server/src/routes/web/instances.ts",
    "packages/agent-runtime/src/routes/web/instances.ts",
  ],
  [
    "src/__tests__/web-instance-runtime-actions.test.ts",
    "apps/server/src/__tests__/web-instance-runtime-actions.test.ts",
    "packages/agent-runtime/src/__tests__/web-instance-runtime-actions.test.ts",
  ],
  [
    "src/routes/web/environments.ts",
    "apps/server/src/routes/web/environments.ts",
    "packages/agent-runtime/src/routes/web/environments.ts",
  ],
  [
    "src/routes/web/peri-task-details.ts",
    "apps/server/src/routes/web/peri-task-details.ts",
    "packages/resources/model-management/src/server/routes/web/peri-task-details.ts",
  ],
  [
    "src/schemas/peri-task-details.ts",
    "apps/server/src/schemas/peri-task-details.ts",
    "packages/resources/model-management/src/server/schemas/peri-task-details.ts",
  ],
  [
    "src/routes/web/meta-agent.ts",
    "apps/server/src/routes/web/meta-agent.ts",
    "packages/resources/agent-config/src/server/routes/web/meta-agent.ts",
  ],
  [
    "src/services/config/user-config.ts",
    "apps/server/src/services/config/user-config.ts",
    "packages/platform/identity/src/repositories/user-config.ts",
  ],
] as const;

describe("RMD-07 server-host migration", () => {
  // 仅这 62 个获批源文件迁入 server host，避免旧根路径或额外迁移悄然出现。
  // 原 75 项中已有九项的目标不再由 server host 持有：
  // 任务 1.4 W4b 的一项：`repositories/agent-engine.ts` 的宿主副本随「两条 LaunchSpec 收敛为一条」删除
  //   （它只为编排域的扁平聚合读取 (`PgAgentEngineRepo`) 供数，收敛后宿主零消费方，按「删除优于兼容」
  //   删除；同批删除的还有 `PgAgentConfigRepo` 的聚合读入口，见 review/task-1.4-agent-runtime.md）。
  //   该文件既没有新的 owner 包，也不该以「已迁入宿主」的身份留在本表里，故整行移出。
  // 任务 1.2 的三项：
  // - `schemas/common.schema.ts` 上移到 `packages/platform/platform-sdk/src/protocol/web-envelope.ts`；
  // - `routes/web/config/providers.ts` 由 Provider 资源包接管
  //   （`packages/resources/model-management/src/server/routes/web/config/providers.ts`），
  //   宿主只保留 `routes/web/config/index.ts` 的挂载；
  // - `errors/index.ts` 被删除：它与 `src/errors.ts` 重复导出第二份 `AppError`，无任何导入方
  //   （`../errors` 始终解析到 `errors.ts`），保留只会让错误语义分叉。
  // 任务 1.3 的两项（详见 review/task-1.3-resource-packages.md §6.1）：
  // - `routes/web/config/sandbox-pools.ts` 由 Sandbox 资源包接管
  //   （`packages/resources/sandbox/src/routes/web/sandbox-pools.ts`），宿主只保留挂载；
  // - `schemas/api-common.schema.ts` 上移到 `packages/platform/platform-sdk/src/protocol/system-api.ts`
  //   （`ApiErrorResponseSchema` 与错误分类法同批下沉，workflow 包的同名转发 shim 一并删除）。
  // 任务 1.3 收口的三项（宿主副本零消费方，宿主侧删除，见下方 relocated 断言）：
  // - `schemas/api-model.schema.ts`、`schemas/config.schema.ts` 的 owner 是 model-management 包；
  // - `schemas/api-workspace.schema.ts` 的 owner 是 machine 包——该宿主文件与包内同名文件**字节相同**
  //   且已无任何导入方，属 §1.3(1) 明令禁止的 app↔package 重复实现，按「删除优于兼容」删除。
  // 任务 1.4 的一项：`src/types/store.ts` 的六个接口在 W1 归位 owner 包（`AcpConnectionEntry` /
  // `AcpConnectionSnapshot` / `WsConnection` → `@fenix/agent-runtime/server`，`InstanceSupplement` 等同文件
  // 内其他字段类型一并收回），实测宿主 0 消费方，按「删除优于兼容」删除宿主文件——它既不是宿主自有类型，
  // 也不该以「已迁入宿主」的身份留在本表里（见 review/task-1.4-agent-runtime.md）。
  // 任务 1.4 W2 的三项（本轮从本表移入下方 relocated 断言）：`schemas/api-instance.schema.ts`、
  // `services/openai-response-mapper.ts` 与后者的协议边界测试
  // `__tests__/round18-openai-response-protocol-boundaries.test.ts`。前两者唯一消费方是 agent-runtime 的
  // `/api/instances` 与 `/api/openai-chat`，测试则只覆盖搬入包内的 mapper；宿主侧已零消费方，按「删除优于
  // 兼容」把宿主副本删除、owner 落回包内。
  // 任务 1.5a 的十二项（本轮移出本表，无新 owner）：宿主侧副本零生产消费方，按「删除优于兼容」删除。
  // 源文件九项：`repositories/index.ts`（全仓无 `@server/repositories` 消费方，仅一处历史注释提及）、
  // `schemas/index.ts`（160 行纯转发 barrel，仓内零 import）、`schemas/sidebar-config.schema.ts`（owner 是
  // agent-config 包，宿主这份的唯一引用就是上面那个 barrel）、`services/automationState.ts` 与
  // `types/api.ts`（两份互相引用形成孤岛，`automation_state` 全仓无写入方，裁定见
  // review/task-1.5-host-aggregation.md §3.6）、`services/config/jsonb.ts`（`parseJsonb` / `parseJsonbOr`
  // 生产零消费方，mcp 包内已有同因实现）、`transport/ws-types.ts` 与 `types/messages.ts`（machine /
  // agent-runtime 各自自持同名类型并已在包内写明取代理由）、`utils/executable.ts`（acp-link 与
  // plugin-ccb / plugin-opencode 各有实现）。
  // 测试三项：`automationState` / `executable` / `jsonb-utils` 的唯一被测对象即上述宿主副本，随被测模块删除。
  // 同批删除的 `plugins/require-team-scope.ts`（生产零消费方）与 `logger.ts`（`@fenix/logger` 的兼容桥、
  // 零消费者）不在本表内，无需在此登记。
  // 任务 1.5c 的十项：`src/routes/hooks.ts`、`src/schemas/session.schema.ts`、`src/services/transport.ts`、
  // `src/routes/web/{instances,environments}.ts` 与 instances 的宿主测试
  // `src/__tests__/web-instance-runtime-actions.test.ts`、`src/routes/web/peri-task-details.ts` 与其协议
  // schema `src/schemas/peri-task-details.ts`、`src/routes/web/meta-agent.ts`、
  // `src/services/config/user-config.ts`
  // 本轮从本表移入下方 relocated 断言（宿主副本删除、owner 落回 workflow / agent-runtime /
  // model-management / agent-config / identity 包），理由见 relocated 的文档注释。
  // 任务 1.5c 的死代码删除一项（本轮移出本表，无新 owner）：`services/config/index.ts`。它是
  // `upsertSystemMcpServer` 的转发 barrel，另两条导出（`AuthContext`、`PermissionAction` /
  // `PermissionConfig`）也无导入方；而 `upsertSystemMcpServer` 服务的唯一端口
  // `RegisterSystemMcpServer` 从未被注入（`ensureHindsightMcpServer` 全仓只有测试调用），整条
  // Hindsight MCP 登记路径未接线，宿主这份属零生产消费方的薄包装，按「删除优于兼容」删除，见
  // review/task-1.5-host-aggregation.md §1.5c-8。同批删除的 `services/config/mcp-system-server.ts`
  // （上述 barrel 的被转发对象，从未单独登记）与 `services/config-utils.ts` 的信封函数（文件本体保留
  // `resolveApiKey`）不在本表内。
  test("removes every legacy source and retains its exact server-host target", () => {
    expect(RMD_07_MOVES).toHaveLength(39);
    for (const [source, target] of RMD_07_MOVES) {
      expect(existsSync(source), `legacy source still exists: ${source}`).toBe(false);
      expect(existsSync(target), `server-host target is missing: ${target}`).toBe(true);
    }
  });

  // Provider / Model / Machine / AgentRuntime 契约、会话控制面与 Webhook 入口的 owner 已在包内：
  // 旧根路径与宿主路径都不得复活，包内必须有唯一落点。
  test("relocates the provider, model, agent runtime, session-control and webhook contracts", () => {
    expect(RMD_07_RELOCATED).toHaveLength(16);
    for (const [legacy, shell, owner] of RMD_07_RELOCATED) {
      expect(existsSync(legacy), `legacy source still exists: ${legacy}`).toBe(false);
      expect(existsSync(shell), `host copy still exists: ${shell}`).toBe(false);
      expect(existsSync(owner), `package owner is missing: ${owner}`).toBe(true);
    }
  });
});
