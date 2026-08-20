import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { readJson, resetAllStubs, stubAuthApi, stubRegistry } from "../test-utils/helpers";

const registryRoutes = (await import("../routes/web/registry")).default;

function request(path: string, init?: RequestInit) {
  return registryRoutes.handle(new Request(`http://localhost${path}`, init));
}

function createMachineRecord() {
  return {
    id: "mach-org-1",
    organizationId: "org-1",
    userId: "user-1",
    agentName: "claude-code",
    name: "build-runner",
    status: "online" as const,
    type: "machine" as const,
    machineInfo: { os: "linux" },
    labels: ["gpu", "ci"],
    maxSessions: 3,
    heartbeatIntervalMs: 30_000,
    lastHeartbeatAt: new Date("2026-08-19T08:00:00.000Z"),
    registeredAt: new Date("2026-08-19T07:00:00.000Z"),
    createdAt: new Date("2026-08-19T07:00:00.000Z"),
    updatedAt: new Date("2026-08-19T08:00:00.000Z"),
  };
}

describe("Registry 路由隔离与认证", () => {
  const listMachines = mock();
  const getMachine = mock();

  beforeEach(() => {
    resetAllStubs();
    listMachines.mockReset();
    getMachine.mockReset();
    setTestAuth({
      user: { id: "user-1", email: "user-1@example.test", name: "测试用户" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "member" },
    });
    stubRegistry({ listMachines, getMachine });
  });

  afterEach(() => {
    resetTestAuth();
    resetAllStubs();
  });

  // 当前组织查询机器列表时应只把认证组织上下文和规范化过滤条件交给服务层。
  test("GET /registry/machines 传递组织上下文、标签与分页条件并序列化时间", async () => {
    listMachines.mockResolvedValue({ data: [createMachineRecord()], total: 1 });

    const response = await request("/registry/machines?status=online&labels=gpu&limit=5&offset=2");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      success: true,
      data: {
        items: [
          {
            ...createMachineRecord(),
            lastHeartbeatAt: 1_787_126_400,
            registeredAt: 1_787_122_800,
            createdAt: 1_787_122_800,
            updatedAt: 1_787_126_400,
          },
        ],
        total: 1,
      },
    });
    expect(listMachines).toHaveBeenCalledWith(
      { organizationId: "org-1", userId: "user-1", role: "member" },
      { status: "online", type: "machine", labels: ["gpu"], limit: 5, offset: 2 },
    );
  });

  // 不属于当前组织或当前用户的机器由服务层隐藏时，路由必须返回 404 而非泄露记录存在性。
  test("GET /registry/machines/:id 对不可见机器返回 404", async () => {
    getMachine.mockResolvedValue(null);

    const response = await request("/registry/machines/mach-foreign");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Machine not found" },
    });
    expect(getMachine).toHaveBeenCalledWith(
      { organizationId: "org-1", userId: "user-1", role: "member" },
      "mach-foreign",
    );
  });

  // 未提供会话或 API Key 时，机器列表不得调用服务层并应拒绝请求。
  test("GET /registry/machines 未认证时返回 401 且不读取机器数据", async () => {
    resetTestAuth();
    stubAuthApi({ getSession: async () => null });

    const response = await request("/registry/machines");

    expect(response.status).toBe(401);
    expect(listMachines).not.toHaveBeenCalled();
  });

  // 列表服务异常只能映射为通用失败响应，避免成功结构掩盖后端故障。
  test("GET /registry/machines 服务失败时返回 500", async () => {
    listMachines.mockRejectedValue(new Error("storage unavailable"));

    const response = await request("/registry/machines");

    expect(response.status).toBe(500);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "storage unavailable" },
    });
  });
});
