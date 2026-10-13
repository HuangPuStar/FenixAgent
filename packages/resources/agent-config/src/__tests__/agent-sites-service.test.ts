import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { initializeAgentConfigModuleConfig } from "../server/testing";

/**
 * 站点链路配置由宿主注入（迁移前读运行环境变量），因此用例统一经生产读取路径
 * `initializeAgentConfigModuleConfig()` 注入配置，而不是改运行环境——改环境已经不再影响服务行为。
 */

const SITE_CONFIG = { agentSitesBaseUrl: "http://localhost:9999", agentSitesMasterKey: "test-master-key" };

describe("agent-sites service — 配置检测", () => {
  beforeEach(() => {
    initializeAgentConfigModuleConfig(SITE_CONFIG);
  });

  afterEach(() => {
    resetAllStubs();
  });

  // 基址与主密钥都由宿主下发时，站点链路报告可用。
  test("isAgentSitesConfigured 配置完整返回 true", async () => {
    const { isAgentSitesConfigured } = await import("../server/services/agent-sites");
    expect(isAgentSitesConfigured()).toBe(true);
  });

  // 缺基址时即使有主密钥也必须报告不可用，避免请求落到错误的相对地址。
  test("isAgentSitesConfigured 缺失 BASE_URL 返回 false", async () => {
    initializeAgentConfigModuleConfig({ agentSitesMasterKey: "test-master-key" });
    const { isAgentSitesConfigured } = await import("../server/services/agent-sites");
    expect(isAgentSitesConfigured()).toBe(false);
  });

  // 缺主密钥时报告不可用：无鉴权的请求会被平台拒绝，不能当成已配置。
  test("isAgentSitesConfigured 缺失 MASTER_KEY 返回 false", async () => {
    initializeAgentConfigModuleConfig({ agentSitesBaseUrl: "http://localhost:9999" });
    const { isAgentSitesConfigured } = await import("../server/services/agent-sites");
    expect(isAgentSitesConfigured()).toBe(false);
  });
});

describe("agent-sites service — 错误类型", () => {
  // 平台错误需要保留状态码，路由侧据此映射响应，不能退化成普通 Error。
  test("AgentSitesError 正确构造", async () => {
    const { AgentSitesError } = await import("../server/services/agent-sites");
    const err = new AgentSitesError(401, "Unauthorized");
    expect(err.status).toBe(401);
    expect(err.message).toBe("Unauthorized");
    expect(err.name).toBe("AgentSitesError");
  });
});

describe("agent-sites service — createRemoteApp type 参数", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    initializeAgentConfigModuleConfig(SITE_CONFIG);
  });

  afterEach(() => {
    resetAllStubs();
    globalThis.fetch = originalFetch;
  });

  // 省略 type 时不能带空字段上游：平台按「缺省即 pocketbase」处理，显式 null 会被判无效。
  test("不传 type 默认走 pocketbase", async () => {
    let capturedBody: string | null = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body ? String(init.body) : null;
      return new Response(
        JSON.stringify({
          data: {
            id: "app-test",
            name: "n",
            type: "pocketbase",
            port: 9000,
            status: "running",
            api_path: "/app-test/api",
            created_at: "2026-07-01",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { createRemoteApp } = await import("../server/services/agent-sites");
    await createRemoteApp("my-app");
    const parsed = JSON.parse(capturedBody!);
    expect(parsed).toEqual({ name: "my-app" }); // 不含 type 字段
  });

  // custom 类型必须透传到平台，否则平台会创建 PocketBase 实例而不是待部署容器。
  test("传 type=custom 透传到平台", async () => {
    let capturedBody: string | null = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body ? String(init.body) : null;
      return new Response(
        JSON.stringify({
          data: {
            id: "app-test",
            name: "n",
            type: "custom",
            port: 0,
            status: "running",
            api_path: "/app-test",
            created_at: "2026-07-01",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { createRemoteApp } = await import("../server/services/agent-sites");
    await createRemoteApp("my-app", "custom");
    const parsed = JSON.parse(capturedBody!);
    expect(parsed).toEqual({ name: "my-app", type: "custom" });
  });
});

describe("agent-sites service — deployCustomApp", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    initializeAgentConfigModuleConfig(SITE_CONFIG);
  });

  afterEach(() => {
    resetAllStubs();
    globalThis.fetch = originalFetch;
  });

  // 部署透传必须带上主密钥与正确的 URL/方法，否则平台会以 401 拒绝且难以定位。
  test("deploy 成功返回平台响应", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Headers | null = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      capturedMethod = init?.method ?? "GET";
      capturedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          data: { files: 3, total_bytes: 1024, entry_file: "main.ts", slot: "a", port: 9005 },
          error: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const { deployCustomApp } = await import("../server/services/agent-sites");
    const fakeBody = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([0x1f, 0x8b]));
        c.close();
      },
    });
    const result = await deployCustomApp("app-test", fakeBody);
    expect(capturedUrl).toBe("http://localhost:9999/api/apps/app-test/deploy");
    expect(capturedMethod).toBe("POST");
    expect(capturedHeaders!.get("X-Master-Key")).toBe("test-master-key");
    expect(result.data).toEqual({
      files: 3,
      total_bytes: 1024,
      entry_file: "main.ts",
      slot: "a",
      port: 9005,
    });
  });

  // 平台业务错误必须保留状态码与原始 message，路由才能把可读原因传给调用方。
  test("deploy 平台返 400 抛 AgentSitesError", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: null,
          error: { code: "BAD_REQUEST", message: "App app-test 不是自定义类型，无法部署" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const { deployCustomApp, AgentSitesError } = await import("../server/services/agent-sites");
    const fakeBody = new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    });
    expect(deployCustomApp("app-test", fakeBody)).rejects.toMatchObject({
      name: "AgentSitesError",
      status: 400,
      message: "App app-test 不是自定义类型，无法部署",
    });
    // 引用 AgentSitesError 防止 TS 未使用警告
    expect(AgentSitesError).toBeDefined();
  });
});
