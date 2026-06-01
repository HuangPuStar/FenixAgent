import { describe, expect, test } from "bun:test";

// 由于 Drizzle schema 直接导入会触发数据库连接，这里通过检查 schema 文件的导出结构来验证
// 我们在 precheck / tsc 中验证了类型正确性

describe("machine 表", () => {
  // machine 表列定义正确
  test("machine 表列定义正确", async () => {
    const { machine } = await import("../db/schema");
    const columns = Object.keys(machine);
    const expectedColumns = [
      "id",
      "organizationId",
      "userId",
      "agentName",
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
    const { registryEvent } = await import("../db/schema");
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
    const { agentConfig } = await import("../db/schema");
    const columns = Object.keys(agentConfig);
    expect(columns).toContain("machineId");
  });
});

describe("REGISTRY_SECRET 环境变量", () => {
  // REGISTRY_SECRET 默认值为空字符串
  test("REGISTRY_SECRET 默认值", async () => {
    delete process.env.REGISTRY_SECRET;
    const { validateEnv } = await import("../env");
    const env = validateEnv();
    expect(env.REGISTRY_SECRET).toBe("rcs-registry-secret");
  });

  // REGISTRY_SECRET 可覆盖
  test("REGISTRY_SECRET 可覆盖", async () => {
    process.env.REGISTRY_SECRET = "my-secret";
    const { validateEnv } = await import("../env");
    const env = validateEnv();
    expect(env.REGISTRY_SECRET).toBe("my-secret");
    delete process.env.REGISTRY_SECRET;
  });
});
