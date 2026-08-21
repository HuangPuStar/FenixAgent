import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import {
  CreateMachineSchema,
  EventQuerySchema,
  MachineQuerySchema,
  UpdateMachineSchema,
} from "../schemas/registry.schema";
import { readJson, resetAllStubs, stubRegistry } from "../test-utils/helpers";

const authContext = { organizationId: "org-a", userId: "user-a", role: "owner" as const };

function machineRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "mach-1",
    organizationId: "org-a",
    userId: null,
    agentName: "opencode",
    name: "builder",
    type: "machine",
    status: "offline",
    machineInfo: null,
    labels: ["gpu"],
    maxSessions: 5,
    heartbeatIntervalMs: 30000,
    lastHeartbeatAt: new Date("2026-08-01T00:00:00.000Z"),
    registeredAt: new Date("2026-08-01T00:00:00.000Z"),
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

async function registryApp() {
  return (await import("../routes/web/registry")).default;
}

beforeEach(() => {
  resetAllStubs();
  setTestAuth({
    user: { id: "user-a", email: "user-a@example.test", name: "User A" },
    authContext,
  });
});

afterEach(() => {
  resetTestAuth();
  resetAllStubs();
});

describe("registry schema 参数与安全边界", () => {
  // 创建请求拒绝空名称，避免生成不可识别的机器记录。
  test("创建机器拒绝空名称", () => {
    expect(CreateMachineSchema.safeParse({ name: "" }).success).toBeFalse();
  });

  // 创建请求拒绝超长名称，限制持久化和展示边界。
  test("创建机器拒绝超过64字符的名称", () => {
    expect(CreateMachineSchema.safeParse({ name: "x".repeat(65) }).success).toBeFalse();
  });

  // 创建请求为可选标签提供稳定默认值。
  test("创建机器默认空标签", () => {
    expect(CreateMachineSchema.parse({ name: "worker" }).labels).toEqual([]);
  });

  // 创建请求为引擎提供兼容默认值。
  test("创建机器默认使用opencode引擎", () => {
    expect(CreateMachineSchema.parse({ name: "worker" }).agentName).toBe("opencode");
  });

  // 标签必须是字符串数组，不能把对象注入配置。
  test("创建机器拒绝非字符串标签", () => {
    expect(CreateMachineSchema.safeParse({ name: "worker", labels: ["safe", 1] }).success).toBeFalse();
  });

  // 引擎名称不能为空，防止运行时命令缺少执行器。
  test("创建机器拒绝空引擎名称", () => {
    expect(CreateMachineSchema.safeParse({ name: "worker", agentName: "" }).success).toBeFalse();
  });

  // 更新允许仅改名称，避免无关字段成为必填项。
  test("更新机器允许仅提交名称", () => {
    expect(UpdateMachineSchema.parse({ name: "new-name" })).toEqual({ name: "new-name" });
  });

  // 更新允许仅替换标签，支持独立的标签维护。
  test("更新机器允许仅提交标签", () => {
    expect(UpdateMachineSchema.parse({ labels: ["gpu"] })).toEqual({ labels: ["gpu"] });
  });

  // 更新拒绝空名称，防止清空机器显示标识。
  test("更新机器拒绝空名称", () => {
    expect(UpdateMachineSchema.safeParse({ name: "" }).success).toBeFalse();
  });

  // 更新拒绝超长引擎名，避免异常配置进入注册表。
  test("更新机器拒绝超长引擎名称", () => {
    expect(UpdateMachineSchema.safeParse({ agentName: "x".repeat(65) }).success).toBeFalse();
  });

  // 列表查询默认只返回普通 machine，避免混入 sandbox。
  test("机器列表查询默认类型为machine", () => {
    expect(MachineQuerySchema.parse({}).type).toBe("machine");
  });

  // 列表查询使用受限的默认分页窗口。
  test("机器列表查询使用默认分页参数", () => {
    expect(MachineQuerySchema.parse({})).toMatchObject({ limit: 20, offset: 0 });
  });

  // 列表查询将字符串分页参数转换为数字。
  test("机器列表查询转换字符串分页参数", () => {
    expect(MachineQuerySchema.parse({ limit: "50", offset: "10" })).toMatchObject({ limit: 50, offset: 10 });
  });

  // 分页大小有上限，防止单次读取无边界数据。
  test("机器列表查询拒绝超过上限的分页大小", () => {
    expect(MachineQuerySchema.safeParse({ limit: 101 }).success).toBeFalse();
  });

  // 分页大小必须为正数，避免无效数据库查询。
  test("机器列表查询拒绝零分页大小", () => {
    expect(MachineQuerySchema.safeParse({ limit: 0 }).success).toBeFalse();
  });

  // 偏移量不可为负，避免数据库分页语义不一致。
  test("机器列表查询拒绝负偏移量", () => {
    expect(MachineQuerySchema.safeParse({ offset: -1 }).success).toBeFalse();
  });

  // 类型过滤只接受预定义枚举，避免任意值进入查询。
  test("机器列表查询拒绝未知类型", () => {
    expect(MachineQuerySchema.safeParse({ type: "remote" }).success).toBeFalse();
  });

  // 事件查询默认采用安全的小分页窗口。
  test("事件查询使用默认分页窗口", () => {
    expect(EventQuerySchema.parse({})).toEqual({ limit: 20, offset: 0 });
  });

  // 事件查询拒绝零页大小，避免无意义的请求。
  test("事件查询拒绝零分页大小", () => {
    expect(EventQuerySchema.safeParse({ limit: 0 }).success).toBeFalse();
  });

  // 事件查询拒绝小数，保证 offset 和 limit 映射到确定行范围。
  test("事件查询拒绝小数分页参数", () => {
    expect(EventQuerySchema.safeParse({ limit: 1.5 }).success).toBeFalse();
  });

  // 事件查询拒绝超过读取窗口上限的分页大小。
  test("事件查询拒绝超过上限的分页大小", () => {
    expect(EventQuerySchema.safeParse({ limit: 101 }).success).toBeFalse();
  });
});

describe("registry Web 路由的鉴权、隔离和失败边界", () => {
  // 当前请求的认证上下文会被传给列表服务，确保服务层按组织和用户隔离数据。
  test("列表路由传递认证上下文", async () => {
    let received: unknown;
    stubRegistry({
      listMachines: async (ctx: unknown) => {
        received = ctx;
        return { data: [], total: 0 };
      },
    });
    const response = await (await registryApp()).handle(new Request("http://localhost/registry/machines"));

    expect(response.status).toBe(200);
    expect(received).toEqual(authContext);
  });

  // 列表路由将服务返回的日期序列化为秒级时间戳。
  test("列表路由序列化机器日期字段", async () => {
    stubRegistry({ listMachines: async () => ({ data: [machineRecord()], total: 1 }) });
    const response = await (await registryApp()).handle(new Request("http://localhost/registry/machines"));
    const body = (await readJson(response)) as { data: { items: Array<{ createdAt: number }>; total: number } };

    expect(response.status).toBe(200);
    expect(body.data.items[0].createdAt).toBe(1785542400);
    expect(body.data.total).toBe(1);
  });

  // 标签参数经过 schema 校验后传入服务边界。
  test("列表路由传递标签筛选参数", async () => {
    let received: unknown;
    stubRegistry({
      listMachines: async (_ctx: unknown, filters: unknown) => {
        received = filters;
        return { data: [], total: 0 };
      },
    });
    const response = await (await registryApp()).handle(
      new Request("http://localhost/registry/machines?labels=gpu&limit=2&offset=1"),
    );

    expect(response.status).toBe(200);
    expect(received).toEqual({ labels: ["gpu"], limit: 2, offset: 1, type: "machine" });
  });

  // 列表路由将 sandbox 类型传递给隔离后的服务查询。
  test("列表路由传递sandbox类型", async () => {
    let received: unknown;
    stubRegistry({
      listMachines: async (_ctx: unknown, filters: unknown) => {
        received = filters;
        return { data: [], total: 0 };
      },
    });
    const response = await (await registryApp()).handle(new Request("http://localhost/registry/machines?type=sandbox"));

    expect(response.status).toBe(200);
    expect(received).toEqual({ labels: undefined, limit: 20, offset: 0, type: "sandbox" });
  });

  // 路由拒绝超过上限的分页参数，避免服务层接收无界读取。
  test("列表路由拒绝超出范围的分页参数", async () => {
    expect(
      (await (await registryApp()).handle(new Request("http://localhost/registry/machines?limit=101"))).status,
    ).toBe(422);
  });

  // 路由拒绝未知机器类型，防止筛选语义漂移。
  test("列表路由拒绝未知机器类型", async () => {
    expect(
      (await (await registryApp()).handle(new Request("http://localhost/registry/machines?type=remote"))).status,
    ).toBe(422);
  });

  // 服务异常被映射为稳定的内部错误响应。
  test("列表路由映射服务异常为500", async () => {
    stubRegistry({
      listMachines: async () => {
        throw new Error("database unavailable");
      },
    });
    const response = await (await registryApp()).handle(new Request("http://localhost/registry/machines"));

    expect(response.status).toBe(500);
  });

  // 创建路由拒绝空名称，避免无效记录进入服务层。
  test("创建路由拒绝空名称", async () => {
    const response = await (await registryApp()).handle(
      new Request("http://localhost/registry/machines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "" }),
      }),
    );

    expect(response.status).toBe(422);
  });

  // 创建路由拒绝非数组标签，避免未验证数据进入注册服务。
  test("创建路由拒绝非数组标签", async () => {
    const response = await (await registryApp()).handle(
      new Request("http://localhost/registry/machines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "worker", labels: "gpu" }),
      }),
    );

    expect(response.status).toBe(422);
  });

  // 创建路由返回服务生成的初始化信息。
  test("创建路由返回初始化信息", async () => {
    stubRegistry({
      createMachine: async () => ({
        id: "mach-1",
        name: "worker",
        status: "pending" as const,
        initCommand: "safe command",
      }),
    });
    const response = await (await registryApp()).handle(
      new Request("http://localhost/registry/machines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "worker" }),
      }),
    );

    expect(await readJson(response)).toEqual({
      success: true,
      data: { id: "mach-1", name: "worker", status: "pending", initCommand: "safe command" },
    });
  });

  // 创建失败不暴露堆栈，仅映射为受控错误。
  test("创建路由映射服务失败", async () => {
    stubRegistry({
      createMachine: async () => {
        throw new Error("write failed");
      },
    });
    const response = await (await registryApp()).handle(
      new Request("http://localhost/registry/machines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "worker" }),
      }),
    );

    expect(response.status).toBe(500);
  });

  // 不可见机器详情统一返回404，避免泄露跨组织存在性。
  test("详情路由把不可见机器映射为404", async () => {
    stubRegistry({ getMachine: async () => null });
    expect(
      (await (await registryApp()).handle(new Request("http://localhost/registry/machines/mach-foreign"))).status,
    ).toBe(404);
  });

  // 详情路由序列化机器和事件时间，保持 API 契约一致。
  test("详情路由序列化机器与事件日期", async () => {
    stubRegistry({
      getMachine: async () => ({
        ...machineRecord(),
        recentEvents: [
          {
            id: "evt-1",
            machineId: "mach-1",
            type: "register",
            detail: {},
            createdAt: new Date("2026-08-01T00:00:00.000Z"),
          },
        ],
      }),
    });
    const response = await (await registryApp()).handle(new Request("http://localhost/registry/machines/mach-1"));
    const body = (await readJson(response)) as { data: { recentEvents: Array<{ createdAt: number }> } };

    expect(response.status).toBe(200);
    expect(body.data.recentEvents[0].createdAt).toBe(1785542400);
  });

  // 详情服务失败被映射为500，客户端可进行重试。
  test("详情路由映射服务异常为500", async () => {
    stubRegistry({
      getMachine: async () => {
        throw new Error("read failed");
      },
    });
    expect((await (await registryApp()).handle(new Request("http://localhost/registry/machines/mach-1"))).status).toBe(
      500,
    );
  });

  // 更新路由拒绝空请求字段，避免无意义的写操作。
  test("更新路由拒绝空名称", async () => {
    const response = await (await registryApp()).handle(
      new Request("http://localhost/registry/machines/mach-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "" }),
      }),
    );

    expect(response.status).toBe(422);
  });

  // 跨组织更新以404呈现，避免暴露机器归属。
  test("更新路由把跨组织机器映射为404", async () => {
    stubRegistry({
      updateMachine: async () => {
        throw new Error("machine 'mach-foreign' not found");
      },
    });
    const response = await (await registryApp()).handle(
      new Request("http://localhost/registry/machines/mach-foreign", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "hijack" }),
      }),
    );

    expect(response.status).toBe(404);
  });

  // 更新路由返回秒级时间戳，避免 Date 泄漏到 JSON 契约。
  test("更新路由序列化日期字段", async () => {
    stubRegistry({ updateMachine: async () => machineRecord() });
    const response = await (await registryApp()).handle(
      new Request("http://localhost/registry/machines/mach-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels: ["linux"] }),
      }),
    );
    const body = (await readJson(response)) as { data: { updatedAt: number } };

    expect(response.status).toBe(200);
    expect(body.data.updatedAt).toBe(1785542400);
  });

  // 事件路由拒绝负偏移量，保护分页边界。
  test("事件路由拒绝负偏移量", async () => {
    expect(
      (await (await registryApp()).handle(new Request("http://localhost/registry/machines/mach-1/events?offset=-1")))
        .status,
    ).toBe(422);
  });

  // 事件路由返回服务给出的隔离分页结果。
  test("事件路由返回分页事件", async () => {
    stubRegistry({
      listEvents: async () => ({
        data: [
          {
            id: "evt-1",
            machineId: "mach-1",
            type: "register",
            detail: {},
            createdAt: new Date("2026-08-01T00:00:00.000Z"),
          },
        ],
        total: 1,
      }),
    });
    const response = await (await registryApp()).handle(
      new Request("http://localhost/registry/machines/mach-1/events?limit=1"),
    );
    const body = (await readJson(response)) as { data: { items: Array<{ createdAt: number }>; total: number } };

    expect(response.status).toBe(200);
    expect(body.data.items[0].createdAt).toBe(1785542400);
    expect(body.data.total).toBe(1);
  });

  // 事件服务异常映射为500，避免返回部分或伪造审计数据。
  test("事件路由映射服务异常为500", async () => {
    stubRegistry({
      listEvents: async () => {
        throw new Error("event store unavailable");
      },
    });
    expect(
      (await (await registryApp()).handle(new Request("http://localhost/registry/machines/mach-1/events"))).status,
    ).toBe(500);
  });

  // 在线机器删除被映射为冲突，阻止活跃连接被提前释放。
  test("删除路由映射在线机器冲突为409", async () => {
    stubRegistry({
      deleteMachine: async () => {
        throw new Error("machine 'mach-1' is online and cannot be deleted");
      },
    });
    expect(
      (
        await (
          await registryApp()
        ).handle(new Request("http://localhost/registry/machines/mach-1", { method: "DELETE" }))
      ).status,
    ).toBe(409);
  });

  // 跨组织删除以404呈现，避免越权探测机器是否存在。
  test("删除路由把跨组织机器映射为404", async () => {
    stubRegistry({
      deleteMachine: async () => {
        throw new Error("machine 'mach-foreign' not found");
      },
    });
    expect(
      (
        await (
          await registryApp()
        ).handle(new Request("http://localhost/registry/machines/mach-foreign", { method: "DELETE" }))
      ).status,
    ).toBe(404);
  });

  // 删除成功返回释放确认，供客户端安全刷新列表。
  test("删除路由返回已释放结果", async () => {
    stubRegistry({ deleteMachine: async () => ({ deleted: true as const }) });
    const response = await (await registryApp()).handle(
      new Request("http://localhost/registry/machines/mach-1", { method: "DELETE" }),
    );

    expect(await readJson(response)).toEqual({ success: true, data: { deleted: true } });
  });
});
