import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { resetAllStubs, stubDb, stubRegistry } from "../test-utils/helpers";

beforeEach(() => {
  resetAllStubs();
  stubDb({});
  setTestAuth({
    user: { id: "owner-1", email: "owner@fenix.com", name: "owner" },
    authContext: { organizationId: "org-1", userId: "owner-1", role: "owner" },
  });
});

afterEach(() => {
  resetTestAuth();
});

describe("registry schema 文件", () => {
  test("MachineSchema 已导出", async () => {
    const { MachineSchema } = await import("../schemas/registry.schema");
    expect(MachineSchema).toBeDefined();
  });

  test("RegistryEventSchema 已导出", async () => {
    const { RegistryEventSchema } = await import("../schemas/registry.schema");
    expect(RegistryEventSchema).toBeDefined();
  });

  test("EventQuerySchema 已导出", async () => {
    const { EventQuerySchema } = await import("../schemas/registry.schema");
    expect(EventQuerySchema).toBeDefined();
  });

  test("MachineQuerySchema 已导出", async () => {
    const { MachineQuerySchema } = await import("../schemas/registry.schema");
    expect(MachineQuerySchema).toBeDefined();
  });

  test("MachineListResponseSchema 已导出", async () => {
    const { MachineListResponseSchema } = await import("../schemas/registry.schema");
    expect(MachineListResponseSchema).toBeDefined();
  });

  test("MachineDetailResponseSchema 已导出", async () => {
    const { MachineDetailResponseSchema } = await import("../schemas/registry.schema");
    expect(MachineDetailResponseSchema).toBeDefined();
  });

  test("RegistryEventListResponseSchema 已导出", async () => {
    const { RegistryEventListResponseSchema } = await import("../schemas/registry.schema");
    expect(RegistryEventListResponseSchema).toBeDefined();
  });
});

describe("registry 路由文件", () => {
  test("路由文件默认导出 app", async () => {
    const mod = await import("../routes/web/registry");
    expect(mod.default).toBeDefined();
  });

  test("路由文件导出 Elysia app 并包含 expected 端点", async () => {
    const mod = await import("../routes/web/registry");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default.handle).toBe("function");
  });

  // 在线机器删除时应返回 409，前端据此提示“先下线或解除引用”。
  test("DELETE /registry/machines/:id maps online conflict to 409", async () => {
    stubRegistry({
      deleteMachine: async () => {
        throw new Error("machine 'mach-online' is online and cannot be deleted");
      },
    });
    const mod = await import("../routes/web/registry");

    const response = await mod.default.handle(
      new Request("http://localhost/registry/machines/mach-online", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(409);
    expect((await response.json()) as unknown).toEqual({
      success: false,
      error: {
        code: "CONFLICT",
        message: "machine 'mach-online' is online and cannot be deleted",
      },
    });
  });

  // 删除成功时返回 deleted=true，供前端刷新列表。
  test("DELETE /registry/machines/:id returns deleted=true", async () => {
    stubRegistry({
      deleteMachine: async () => ({ deleted: true as const }),
    });
    const mod = await import("../routes/web/registry");

    const response = await mod.default.handle(
      new Request("http://localhost/registry/machines/mach-offline", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      success: true,
      data: {
        deleted: true,
      },
    });
  });

  // 非当前组织的机器更新应表现为 not found，避免越权修改。
  test("PATCH /registry/machines/:id maps foreign machine to 404", async () => {
    stubRegistry({
      updateMachine: async () => {
        throw new Error("machine 'mach-foreign' not found");
      },
    });
    const mod = await import("../routes/web/registry");

    const response = await mod.default.handle(
      new Request("http://localhost/registry/machines/mach-foreign", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "builder-02" }),
      }),
    );

    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toEqual({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "machine 'mach-foreign' not found",
      },
    });
  });

  // 非当前组织的机器删除应表现为 not found，避免越权删除。
  test("DELETE /registry/machines/:id maps foreign machine to 404", async () => {
    stubRegistry({
      deleteMachine: async () => {
        throw new Error("machine 'mach-foreign' not found");
      },
    });
    const mod = await import("../routes/web/registry");

    const response = await mod.default.handle(
      new Request("http://localhost/registry/machines/mach-foreign", {
        method: "DELETE",
      }),
    );

    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toEqual({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "machine 'mach-foreign' not found",
      },
    });
  });

  // 公共机器仅允许查看，不允许修改，避免把共享资源当成个人机器编辑。
  test("PATCH /registry/machines/:id maps public machine to 404", async () => {
    stubRegistry({
      updateMachine: async () => {
        throw new Error("machine 'mach-public' not found");
      },
    });
    const mod = await import("../routes/web/registry");

    const response = await mod.default.handle(
      new Request("http://localhost/registry/machines/mach-public", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "shared-builder" }),
      }),
    );

    expect(response.status).toBe(404);
    expect((await response.json()) as unknown).toEqual({
      success: false,
      error: {
        code: "NOT_FOUND",
        message: "machine 'mach-public' not found",
      },
    });
  });

  // 更新接口返回基础机器信息，不应错误要求 recentEvents。
  test("PATCH /registry/machines/:id accepts machine record response without recentEvents", async () => {
    stubRegistry({
      updateMachine: async () => ({
        id: "mach-1",
        organizationId: "org-1",
        userId: null,
        agentName: "opencode",
        name: "builder-01",
        status: "offline",
        machineInfo: null,
        labels: ["sandbox"],
        maxSessions: 5,
        heartbeatIntervalMs: 30000,
        lastHeartbeatAt: null,
        registeredAt: new Date("2026-07-30T02:00:00.000Z"),
        createdAt: new Date("2026-07-30T02:00:00.000Z"),
        updatedAt: new Date("2026-07-30T02:10:00.000Z"),
      }),
    });
    const mod = await import("../routes/web/registry");

    const response = await mod.default.handle(
      new Request("http://localhost/registry/machines/mach-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "builder-01" }),
      }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({
      success: true,
      data: {
        id: "mach-1",
        organizationId: "org-1",
        userId: null,
        agentName: "opencode",
        name: "builder-01",
        status: "offline",
        machineInfo: null,
        labels: ["sandbox"],
        maxSessions: 5,
        heartbeatIntervalMs: 30000,
        lastHeartbeatAt: null,
        registeredAt: 1785376800,
        createdAt: 1785376800,
        updatedAt: 1785377400,
      },
    });
  });
});

describe("schemas/index.ts 导出 registry", () => {
  test("schemas index 导出 MachineSchema", async () => {
    const mod = await import("../schemas");
    expect(mod.MachineSchema).toBeDefined();
  });

  test("schemas index 导出 RegistryEventSchema", async () => {
    const mod = await import("../schemas");
    expect(mod.RegistryEventSchema).toBeDefined();
  });
});

describe("web/index.ts 注册 registry 路由", () => {
  test("web index 导入 webRegistry", async () => {
    const mod = await import("../routes/web/index");
    expect(mod.default).toBeDefined();
  });
});
