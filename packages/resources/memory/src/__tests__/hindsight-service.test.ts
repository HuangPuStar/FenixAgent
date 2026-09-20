import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubIdentityDirectory } from "@fenix/platform-sdk/testing";
import {
  ensureBank,
  ensureHindsightMcpServer,
  getHindsightConfig,
  getMemoryConfig,
  isHindsightAvailable,
  proxyToHindsight,
  type RegisterSystemMcpServer,
  resolveMemberId,
} from "@fenix/resource-memory/server";
import { initializeMemoryModuleConfig } from "../server/testing";

/** 测试用 Hindsight 服务地址（写入模块配置，不再经 process.env）。 */
const TEST_HINDSIGHT_URL = "http://localhost:8888";
/** 测试用 member ID，对应 resolveMemberId 的返回值。 */
const TEST_MEMBER_ID = "member-service-test";

describe("hindsight service", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; options?: RequestInit }[] = [];
  let upstream: () => Promise<Response> = async () => Response.json({ ok: true });

  beforeEach(() => {
    // 模块配置是服务层唯一的配置来源：先按生产读取路径装配，再声明本用例的外部替身。
    initializeMemoryModuleConfig({ hindsightMcpUrl: TEST_HINDSIGHT_URL });
    fetchCalls = [];
    upstream = async () => Response.json({ ok: true });
    globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push({ url, options });
      return upstream();
    }) as typeof fetch;
    stubIdentityDirectory({ resolveMembershipId: async () => TEST_MEMBER_ID });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAllStubs();
  });

  // 未配置服务地址时读取配置返回 null（记忆能力整体按未启用处理）。
  test("未配置 hindsightMcpUrl 时 getHindsightConfig 返回 null", () => {
    initializeMemoryModuleConfig();
    expect(getHindsightConfig()).toBeNull();
  });

  // 配置存在时返回地址，且系统级可用性与之一致。
  test("配置 hindsightMcpUrl 后返回 url 并报告可用", () => {
    expect(getHindsightConfig()).toEqual({ url: TEST_HINDSIGHT_URL });
    expect(isHindsightAvailable()).toBe(true);
  });

  // docker 默认部署的 `${HINDSIGHT_MCP_URL:-}` 会透传空串：空串必须与「未配置」等价，
  // 否则最常见的「未部署记忆」形态会从静默禁用变成校验抛错。
  test("hindsightMcpUrl 为空串时按未配置处理而不抛错", () => {
    initializeMemoryModuleConfig({ hindsightMcpUrl: "" });
    expect(getHindsightConfig()).toBeNull();
    expect(isHindsightAvailable()).toBe(false);
  });

  // 空串与「字段缺失」必须归一到同一份配置：两种外部形状只是同一个「未部署」事实的不同写法，
  // 若只归一其中一种，宿主换一种透传方式就会改变记忆模块的可用性判定。
  test("空串与缺失字段归一为同一份模块配置", () => {
    initializeMemoryModuleConfig({ hindsightMcpUrl: "" });
    const fromEmptyString = getMemoryConfig();
    initializeMemoryModuleConfig();
    expect(fromEmptyString).toEqual(getMemoryConfig());
  });

  // 未配置时系统级可用性为 false，不得让调用方以为记忆已生效。
  test("未配置时 isHindsightAvailable 返回 false", () => {
    initializeMemoryModuleConfig();
    expect(isHindsightAvailable()).toBe(false);
  });

  // 模块配置形状非法（非字符串地址）必须抛出，而不是被当作「未配置」静默降级。
  test("模块配置形状非法时抛出校验错误且不回显字段值", () => {
    initializeMemoryModuleConfig({ hindsightMcpUrl: 42 as unknown as string });
    expect(() => getHindsightConfig()).toThrow(/memory 模块配置校验失败/);
  });

  // bank ID 由身份目录解析，不能退化为用户级或共享 bank。
  test("resolveMemberId 经身份目录解析成员映射", async () => {
    await expect(resolveMemberId({ organizationId: "org-1", userId: "user-1" })).resolves.toBe(TEST_MEMBER_ID);
    stubIdentityDirectory({ resolveMembershipId: async () => undefined });
    await expect(resolveMemberId({ organizationId: "org-1", userId: "user-1" })).resolves.toBeNull();
  });

  // bank 登记是幂等 PUT，且要求非空 body（Hindsight 对空 body 返回 422）。
  test("ensureBank 以 PUT 与空 JSON body 登记 bank", async () => {
    await expect(ensureBank(TEST_MEMBER_ID)).resolves.toEqual({ ok: true });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${TEST_HINDSIGHT_URL}/v1/default/banks/${TEST_MEMBER_ID}`);
    expect(fetchCalls[0].options?.method).toBe("PUT");
    expect(fetchCalls[0].options?.body).toBe("{}");
  });

  // 上游非 2xx 时保留状态码与响应体摘要，便于定位失败原因。
  test("ensureBank 上游非 2xx 时返回失败详情", async () => {
    upstream = async () => new Response("boom", { status: 500 });
    const result = await ensureBank(TEST_MEMBER_ID);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("500");
  });

  // 上游不可达时返回失败而不是抛出，交由调用方决定降级方式。
  test("ensureBank 上游不可达时返回失败", async () => {
    upstream = async () => Promise.reject(new Error("ECONNREFUSED"));
    const result = await ensureBank(TEST_MEMBER_ID);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  // 未配置服务地址时 bank 登记直接失败，不应发出请求。
  test("未配置时 ensureBank 不发起请求", async () => {
    initializeMemoryModuleConfig();
    await expect(ensureBank(TEST_MEMBER_ID)).resolves.toMatchObject({ ok: false });
    expect(fetchCalls).toHaveLength(0);
  });

  // MCP server 登记：固定名称、remote 类型、指向该成员 bank 的地址，归属取当前组织与用户。
  test("ensureHindsightMcpServer 经注入入口登记系统托管 server 并确保 bank", async () => {
    const registrations: Parameters<RegisterSystemMcpServer>[0][] = [];
    const registerSystemMcpServer: RegisterSystemMcpServer = async (input) => {
      registrations.push(input);
      return "mcp-server-id";
    };

    await expect(
      ensureHindsightMcpServer({ organizationId: "org-1", userId: "user-1" }, { registerSystemMcpServer }),
    ).resolves.toEqual({ ok: true });

    expect(registrations).toEqual([
      {
        name: "hindsight",
        type: "remote",
        config: { type: "remote", url: `${TEST_HINDSIGHT_URL}/mcp/${TEST_MEMBER_ID}` },
        organizationId: "org-1",
        ownerUserId: "user-1",
      },
    ]);
    expect(fetchCalls[0].url).toBe(`${TEST_HINDSIGHT_URL}/v1/default/banks/${TEST_MEMBER_ID}`);
  });

  // 无法解析成员映射时不得登记 server，避免把 MCP 条目挂到无主的 bank 上。
  test("ensureHindsightMcpServer 无成员映射时不登记", async () => {
    stubIdentityDirectory({ resolveMembershipId: async () => undefined });
    let called = false;
    const registerSystemMcpServer: RegisterSystemMcpServer = async () => {
      called = true;
      return "mcp-server-id";
    };

    const result = await ensureHindsightMcpServer(
      { organizationId: "org-1", userId: "user-1" },
      { registerSystemMcpServer },
    );
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  // bank 登记失败时整体判为失败（server 记录已幂等写入，重试安全）。
  test("ensureHindsightMcpServer bank 登记失败时返回失败", async () => {
    upstream = async () => new Response("boom", { status: 503 });
    const result = await ensureHindsightMcpServer(
      { organizationId: "org-1", userId: "user-1" },
      { registerSystemMcpServer: async () => "mcp-server-id" },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("503");
  });

  // 转发出口把 path 原样拼接到配置地址上，调用方负责传入正确的 bank 子路径。
  test("proxyToHindsight 拼接配置地址转发请求", async () => {
    await proxyToHindsight("/v1/default/banks/bank-1/stats", { method: "GET" });
    expect(fetchCalls[0].url).toBe(`${TEST_HINDSIGHT_URL}/v1/default/banks/bank-1/stats`);
  });

  // 未配置时转发直接抛错：调用方（路由）据此映射为 503，而不是把请求发到未定义地址。
  test("未配置时 proxyToHindsight 抛出未配置错误", async () => {
    initializeMemoryModuleConfig();
    await expect(proxyToHindsight("/v1/x")).rejects.toThrow(/hindsightMcpUrl/);
    expect(fetchCalls).toHaveLength(0);
  });
});
