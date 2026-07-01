import { afterEach, beforeEach, describe, expect, test } from "bun:test";

describe("agent-sites service — 配置检测", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.AGENT_SITES_BASE_URL = "http://localhost:9999";
    process.env.AGENT_SITES_MASTER_KEY = "test-master-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
  });

  test("isAgentSitesConfigured 配置完整返回 true", async () => {
    const { isAgentSitesConfigured } = await import("../services/agent-sites");
    expect(isAgentSitesConfigured()).toBe(true);
  });

  test("isAgentSitesConfigured 缺失 BASE_URL 返回 false", async () => {
    delete process.env.AGENT_SITES_BASE_URL;
    const { isAgentSitesConfigured } = await import("../services/agent-sites");
    expect(isAgentSitesConfigured()).toBe(false);
  });

  test("isAgentSitesConfigured 缺失 MASTER_KEY 返回 false", async () => {
    delete process.env.AGENT_SITES_MASTER_KEY;
    const { isAgentSitesConfigured } = await import("../services/agent-sites");
    expect(isAgentSitesConfigured()).toBe(false);
  });
});

describe("agent-sites service — 错误类型", () => {
  test("AgentSitesError 正确构造", async () => {
    const { AgentSitesError } = await import("../services/agent-sites");
    const err = new AgentSitesError(401, "Unauthorized");
    expect(err.status).toBe(401);
    expect(err.message).toBe("Unauthorized");
    expect(err.name).toBe("AgentSitesError");
  });
});

describe("agent-sites service — createRemoteApp type 参数", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.AGENT_SITES_BASE_URL = "http://localhost:9999";
    process.env.AGENT_SITES_MASTER_KEY = "test-master-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
    globalThis.fetch = originalFetch;
  });

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

    const { createRemoteApp } = await import("../services/agent-sites");
    await createRemoteApp("my-app");
    const parsed = JSON.parse(capturedBody!);
    expect(parsed).toEqual({ name: "my-app" }); // 不含 type 字段
  });

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

    const { createRemoteApp } = await import("../services/agent-sites");
    await createRemoteApp("my-app", "custom");
    const parsed = JSON.parse(capturedBody!);
    expect(parsed).toEqual({ name: "my-app", type: "custom" });
  });
});

describe("agent-sites service — deployCustomApp", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.AGENT_SITES_BASE_URL = "http://localhost:9999";
    process.env.AGENT_SITES_MASTER_KEY = "test-master-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
    globalThis.fetch = originalFetch;
  });

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

    const { deployCustomApp } = await import("../services/agent-sites");
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

  test("deploy 平台返 400 抛 AgentSitesError", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: null,
          error: { code: "BAD_REQUEST", message: "App app-test 不是自定义类型，无法部署" },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;

    const { deployCustomApp, AgentSitesError } = await import("../services/agent-sites");
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
