import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

const RMD_07_MOVES = [
  ["src/repositories/agent-engine.ts", "apps/server/src/repositories/agent-engine.ts"],
  ["src/repositories/index.ts", "apps/server/src/repositories/index.ts"],
  ["src/routes/hooks.ts", "apps/server/src/routes/hooks.ts"],
  ["src/routes/web/index.ts", "apps/server/src/routes/web/index.ts"],
  ["src/routes/web/environments.ts", "apps/server/src/routes/web/environments.ts"],
  ["src/routes/web/instances.ts", "apps/server/src/routes/web/instances.ts"],
  ["src/routes/web/meta-agent.ts", "apps/server/src/routes/web/meta-agent.ts"],
  ["src/routes/web/peri-task-details.ts", "apps/server/src/routes/web/peri-task-details.ts"],
  ["src/routes/web/config/index.ts", "apps/server/src/routes/web/config/index.ts"],
  ["src/routes/web/config/sandbox-pools.ts", "apps/server/src/routes/web/config/sandbox-pools.ts"],
  ["src/schemas/api-common.schema.ts", "apps/server/src/schemas/api-common.schema.ts"],
  ["src/schemas/api-instance.schema.ts", "apps/server/src/schemas/api-instance.schema.ts"],
  ["src/schemas/api-model.schema.ts", "apps/server/src/schemas/api-model.schema.ts"],
  ["src/schemas/api-workspace.schema.ts", "apps/server/src/schemas/api-workspace.schema.ts"],
  ["src/schemas/config.schema.ts", "apps/server/src/schemas/config.schema.ts"],
  ["src/schemas/index.ts", "apps/server/src/schemas/index.ts"],
  ["src/schemas/peri-task-details.ts", "apps/server/src/schemas/peri-task-details.ts"],
  ["src/schemas/session.schema.ts", "apps/server/src/schemas/session.schema.ts"],
  ["src/schemas/sidebar-config.schema.ts", "apps/server/src/schemas/sidebar-config.schema.ts"],
  ["src/services/automationState.ts", "apps/server/src/services/automationState.ts"],
  ["src/services/build-info.ts", "apps/server/src/services/build-info.ts"],
  ["src/services/config-utils.ts", "apps/server/src/services/config-utils.ts"],
  ["src/services/config/index.ts", "apps/server/src/services/config/index.ts"],
  ["src/services/config/jsonb.ts", "apps/server/src/services/config/jsonb.ts"],
  ["src/services/config/types.ts", "apps/server/src/services/config/types.ts"],
  ["src/services/config/user-config.ts", "apps/server/src/services/config/user-config.ts"],
  ["src/services/core-bootstrap.ts", "apps/server/src/services/core-bootstrap.ts"],
  ["src/services/data-migrate.ts", "apps/server/src/services/data-migrate.ts"],
  [
    "src/services/data-migrates/migrate-agent-config-model-id.ts",
    "apps/server/src/services/data-migrates/migrate-agent-config-model-id.ts",
  ],
  ["src/services/openai-response-mapper.ts", "apps/server/src/services/openai-response-mapper.ts"],
  ["src/services/sync-builtin.ts", "apps/server/src/services/sync-builtin.ts"],
  ["src/services/transport.ts", "apps/server/src/services/transport.ts"],
  ["src/transport/ws-types.ts", "apps/server/src/transport/ws-types.ts"],
  ["src/types/api.ts", "apps/server/src/types/api.ts"],
  ["src/types/global.d.ts", "apps/server/src/types/global.d.ts"],
  ["src/types/messages.ts", "apps/server/src/types/messages.ts"],
  ["src/types/store.ts", "apps/server/src/types/store.ts"],
  ["src/utils/executable.ts", "apps/server/src/utils/executable.ts"],
  ...[
    "agent-platform-api-reference.test.ts",
    "architecture-check.test.ts",
    "automationState.test.ts",
    "build-info.test.ts",
    "capabilities-coalescing.test.ts",
    "config-integration.test.ts",
    "config-validators.test.ts",
    "data-migrate.test.ts",
    "engine-type-schema.test.ts",
    "error-class-semantics.test.ts",
    "error-handler.test.ts",
    "executable.test.ts",
    "jsonb-utils.test.ts",
    "migrate-agent-config-model-id.test.ts",
    "pagination-bounds.test.ts",
    "peri-task-detail-service.test.ts",
    "phone-signup-route.test.ts",
    "round15-isolated-service-boundaries.test.ts",
    "round16-isolated-protocol-boundaries.test.ts",
    "round18-agent-config-model-migration-boundaries.test.ts",
    "round18-openai-response-protocol-boundaries.test.ts",
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
    "web-instance-runtime-actions.test.ts",
    "workspace-symlink-escape.test.ts",
  ].map((file) => [`src/__tests__/${file}`, `apps/server/src/__tests__/${file}`] as const),
] as const;

describe("RMD-07 server-host migration", () => {
  // 仅这 72 个获批源文件迁入 server host，避免旧根路径或额外迁移悄然出现。
  // 原 75 项中已有三项随 CE 阶段 2 任务 1.2 离开 server host：
  // - `schemas/common.schema.ts` 上移到 `packages/platform/platform-sdk/src/protocol/web-envelope.ts`；
  // - `routes/web/config/providers.ts` 由 Provider 资源包接管
  //   （`packages/resources/model-management/src/server/routes/web/config/providers.ts`），
  //   宿主只保留 `routes/web/config/index.ts` 的挂载；
  // - `errors/index.ts` 被删除：它与 `src/errors.ts` 重复导出第二份 `AppError`，无任何导入方
  //   （`../errors` 始终解析到 `errors.ts`），保留只会让错误语义分叉。
  test("removes every legacy source and retains its exact server-host target", () => {
    expect(RMD_07_MOVES).toHaveLength(72);
    for (const [source, target] of RMD_07_MOVES) {
      expect(existsSync(source), `legacy source still exists: ${source}`).toBe(false);
      expect(existsSync(target), `server-host target is missing: ${target}`).toBe(true);
    }
  });
});
