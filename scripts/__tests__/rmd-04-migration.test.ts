import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

/**
 * RMD-04 的获批迁移表，三元组的第三项是**再次搬迁后的现址**（缺省表示未再移动）。
 *
 * CE 阶段 2 任务 1.2 把资源包的协议层收敛到 `src/server/`（routes / services / schemas 分层），有 5 项
 * 因此二次搬迁：旧的目标路径必须为空（不得复活），现址必须存在——与 `rmd-06-migration.test.ts` 记录的
 * 既有模式一致：中间落点写进历史，而不是把断言删掉或把旧路径当成没问题。
 */
const RMD_04_MOVES = [
  [
    "src/routes/api/models.ts",
    "packages/resources/model-management/src/routes/api/models.ts",
    "packages/resources/model-management/src/server/routes/api/models.ts",
  ],
  // CE 阶段 2 任务 1.2 把资源包的协议层收敛到 `src/server/`（routes / facades / services / repositories
  // 各自分层），`web/config/models.ts` 随之再搬一次；RMD-04 的中间落点不得残留。
  ["src/routes/web/config/models.ts", "packages/resources/model-management/src/server/routes/web/config/models.ts"],
  [
    "src/services/peri-task-detail-service.ts",
    "packages/resources/model-management/src/services/peri-task-detail-service.ts",
  ],
  [
    "src/services/peri-task-detail-store.ts",
    "packages/resources/model-management/src/services/peri-task-detail-store.ts",
  ],
  ...[
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
    // RMD-04 判定时落在 model-management；W2.5 收尾按「单归属」把组件移入 knowledge（它管的是 RAGFlow
    // embedding 模型、数据面是 knowledge 路由，且两包当时互引成环）。第二项保留原判定供追溯，第三项是当前落点。
    "packages/resources/knowledge/web/src/pages/agent-panel/components/EmbeddingModelManager.tsx",
  ],
  [
    "web/src/__tests__/agent-editor-model.test.ts",
    "packages/resources/model-management/web/src/__tests__/agent-editor-model.test.ts",
  ],
  [
    "src/services/meta-agent.ts",
    "packages/resources/agent-config/src/services/meta-agent.ts",
    "packages/resources/agent-config/src/server/services/meta-agent.ts",
  ],
  [
    "src/services/sidebar-config.ts",
    "packages/resources/agent-config/src/services/sidebar-config.ts",
    "packages/resources/agent-config/src/server/services/sidebar-config.ts",
  ],
  [
    "src/schemas/meta-agent.schema.ts",
    "packages/resources/agent-config/src/schemas/meta-agent.schema.ts",
    "packages/resources/agent-config/src/server/schemas/meta-agent.schema.ts",
  ],
  [
    "src/routes/web/sidebar-config.ts",
    "packages/resources/agent-config/src/routes/web/sidebar-config.ts",
    "packages/resources/agent-config/src/server/routes/web/sidebar-config.ts",
  ],
  ...["api-agent-schema", "meta-agent", "sidebar-config-service", "web-sidebar-config-routes"].map((name) => [
    `src/__tests__/${name}.test.ts`,
    `packages/resources/agent-config/src/__tests__/${name}.test.ts`,
  ]),
  // §1.6 T12 第三次搬迁：该客户端从 `web/src/api/` 提到 `web/lib/`，以窄子路径出口
  // `./web/lib/meta-agent` 发布（同 `web/lib/agent-create-navigation` 的先例）。
  [
    "web/src/api/meta-agent.ts",
    "packages/resources/agent-config/web/src/api/meta-agent.ts",
    "packages/resources/agent-config/web/lib/meta-agent.ts",
  ],
  ["web/src/api/sidebar-config.ts", "packages/resources/agent-config/web/src/api/sidebar-config.ts"],
  // 这两条随 §1.6 T11d 再次搬迁：包内 `AgentSidebarConfig` 与宿主同源副本同批退场，侧栏装配与裁剪
  // 的 owner 归宿主 WebShell。`-filter-pure` 是逐字 port（50 条边界断言）；`agent-sidebar-config`
  // 的三条裁剪断言改写进 `shell-navigation.test.ts` 的「运行时裁剪」一组，并补上装配期不变量。
  [
    "web/src/__tests__/agent-sidebar-config-filter-pure.test.ts",
    "packages/resources/agent-config/web/src/__tests__/agent-sidebar-config-filter-pure.test.ts",
    "apps/web/src/__tests__/shell-navigation-filter.test.ts",
  ],
  [
    "web/src/__tests__/agent-sidebar-config.test.ts",
    "packages/resources/agent-config/web/src/__tests__/agent-sidebar-config.test.ts",
    "apps/web/src/__tests__/shell-navigation.test.ts",
  ],
] as const;

describe("RMD-04 ownership migration", () => {
  // 31 个保留的源文件必须只存在于其指定资源包中，防止旧根路径悄然复活。
  test("removes every legacy source and retains its exact owner target", () => {
    expect(RMD_04_MOVES).toHaveLength(31);
    for (const [source, rmd04Target, currentTarget] of RMD_04_MOVES) {
      expect(existsSync(source), `legacy source still exists: ${source}`).toBe(false);
      expect(existsSync(currentTarget ?? rmd04Target), `owner target is missing: ${currentTarget ?? rmd04Target}`).toBe(
        true,
      );
      if (currentTarget !== undefined && currentTarget !== rmd04Target) {
        expect(existsSync(rmd04Target), `stale RMD-04 target still exists: ${rmd04Target}`).toBe(false);
      }
    }
  });

  // 已批准退役的污染测试在旧根路径和资源包中都不得复活。
  test("keeps the retired model gateway route test deleted", () => {
    expect(existsSync("src/__tests__/model-gateway-admin-ui-route.test.ts")).toBe(false);
    expect(existsSync("packages/resources/model-management/src/__tests__/model-gateway-admin-ui-route.test.ts")).toBe(
      false,
    );
  });
});
