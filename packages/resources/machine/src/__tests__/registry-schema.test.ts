import { describe, expect, test } from "bun:test";

// 由于 Drizzle schema 直接导入会触发数据库连接，这里通过检查 schema 文件的导出结构来验证
// 我们在 precheck / tsc 中验证了类型正确性

describe("machine 表", () => {
  // machine 表列定义正确
  test("machine 表列定义正确", async () => {
    const { machine } = await import("@server/db/schema");
    const columns = Object.keys(machine);
    const expectedColumns = [
      "id",
      "organizationId",
      "userId",
      "agentName",
      "name",
      "status",
      "machineInfo",
      "labels",
      "maxSessions",
      "heartbeatIntervalMs",
      "lastHeartbeatAt",
      "registeredAt",
      "createdAt",
      "updatedAt",
    ];
    for (const col of expectedColumns) {
      expect(columns).toContain(col);
    }
  });
});

describe("registry_event 表", () => {
  // registry_event 表列定义正确
  test("registry_event 表列定义正确", async () => {
    const { registryEvent } = await import("@server/db/schema");
    const columns = Object.keys(registryEvent);
    const expectedColumns = ["id", "machineId", "type", "detail", "createdAt"];
    for (const col of expectedColumns) {
      expect(columns).toContain(col);
    }
  });
});

describe("agentConfig 新增 machineId 外键列", () => {
  // agentConfig 新增 machineId 外键列
  test("agentConfig 包含 machineId 列", async () => {
    const { agentConfig } = await import("@server/db/schema");
    const columns = Object.keys(agentConfig);
    expect(columns).toContain("machineId");
  });
});

// 已删除「REGISTRY_SECRET 环境变量」两条用例（默认值 / 可覆盖）：该变量由 agent-runtime 的 `/acp/ws`、
// `/acp/ws/fs` 端点校验（`packages/agent-runtime/src/routes/acp/index.ts` 读 `validateEnv().REGISTRY_SECRET`），
// 迁移前本包注册路由经它做机器侧接入鉴权，收敛后本包已无任何读取点（全仓 grep 确认）。留在包内只能经
// `@server/env` 断言宿主内部变量，正是本任务要切断的宿主依赖；宿主 env 的默认值断言应归宿主 env 用例
//（见交付说明的 sharedPatches：建议宿主补上，本任务不写 apps/**）。

describe("registry schema 文件导出", () => {
  test("UpdateMachineSchema 已导出", async () => {
    const { UpdateMachineSchema } = await import("../schemas/registry.schema");
    expect(UpdateMachineSchema).toBeDefined();
  });
});
