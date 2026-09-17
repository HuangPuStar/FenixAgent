import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

const RMD_04_MOVES = [
  ["src/routes/api/models.ts", "packages/resources/model-management/src/routes/api/models.ts"],
  ["src/routes/web/config/models.ts", "packages/resources/model-management/src/routes/web/config/models.ts"],
  [
    "src/services/peri-task-detail-service.ts",
    "packages/resources/model-management/src/services/peri-task-detail-service.ts",
  ],
  [
    "src/services/peri-task-detail-store.ts",
    "packages/resources/model-management/src/services/peri-task-detail-store.ts",
  ],
  ...[
    "model-gateway-admin-ui-route",
    "model-gateway-budget-service",
    "model-gateway-credential-service",
    "model-gateway-credential",
    "model-gateway-key-management-service",
    "model-gateway-model-sync",
    "model-gateway-provider-service",
    "model-gateway-runtime-credential-resolver",
    "model-gateway-schema",
    "model-gateway-subject-service",
    "model-gateway-usage-mapping-service",
    "model-gateway-usage-service",
  ].map((name) => [
    `src/__tests__/${name}.test.ts`,
    `packages/resources/model-management/src/__tests__/${name}.test.ts`,
  ]),
  [
    "web/src/pages/agent-panel/pages/AlgorithmsPage.tsx",
    "packages/resources/model-management/web/src/pages/agent-panel/pages/AlgorithmsPage.tsx",
  ],
  [
    "web/src/pages/agent-panel/pages/AlgorithmDetailDialog.tsx",
    "packages/resources/model-management/web/src/pages/agent-panel/pages/AlgorithmDetailDialog.tsx",
  ],
  [
    "web/src/pages/agent-panel/components/EmbeddingModelManager.tsx",
    "packages/resources/model-management/web/src/pages/agent-panel/components/EmbeddingModelManager.tsx",
  ],
  [
    "web/src/__tests__/agent-editor-model.test.ts",
    "packages/resources/model-management/web/src/__tests__/agent-editor-model.test.ts",
  ],
  ["src/services/meta-agent.ts", "packages/resources/agent-config/src/services/meta-agent.ts"],
  ["src/services/sidebar-config.ts", "packages/resources/agent-config/src/services/sidebar-config.ts"],
  ["src/schemas/meta-agent.schema.ts", "packages/resources/agent-config/src/schemas/meta-agent.schema.ts"],
  ["src/routes/web/sidebar-config.ts", "packages/resources/agent-config/src/routes/web/sidebar-config.ts"],
  ...["api-agent-schema", "meta-agent", "sidebar-config-service", "web-sidebar-config-routes"].map((name) => [
    `src/__tests__/${name}.test.ts`,
    `packages/resources/agent-config/src/__tests__/${name}.test.ts`,
  ]),
  ["web/src/api/meta-agent.ts", "packages/resources/agent-config/web/src/api/meta-agent.ts"],
  ["web/src/api/sidebar-config.ts", "packages/resources/agent-config/web/src/api/sidebar-config.ts"],
  ...["agent-sidebar-config-filter-pure", "agent-sidebar-config"].map((name) => [
    `web/src/__tests__/${name}.test.ts`,
    `packages/resources/agent-config/web/src/__tests__/${name}.test.ts`,
  ]),
] as const;

describe("RMD-04 ownership migration", () => {
  // 32 个已批准的源文件必须只存在于其指定资源包中，防止旧根路径悄然复活。
  test("removes every legacy source and retains its exact owner target", () => {
    expect(RMD_04_MOVES).toHaveLength(32);
    for (const [source, target] of RMD_04_MOVES) {
      expect(existsSync(source), `legacy source still exists: ${source}`).toBe(false);
      expect(existsSync(target), `owner target is missing: ${target}`).toBe(true);
    }
  });
});
