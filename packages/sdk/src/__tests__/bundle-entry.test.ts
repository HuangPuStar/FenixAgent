import { afterEach, describe, expect, it } from "bun:test";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("bundle-entry fetch interceptor logic", () => {
  // 直接测试拦截逻辑，不依赖模块级 side effects 的重新执行
  // bundle-entry 的拦截逻辑等价于以下函数
  function createInterceptor(baseUrl: string, token: string, originalFetch: typeof fetch) {
    return (input: RequestInfo | URL, init?: RequestInit) => {
      let url: string;
      if (typeof input === "string") {
        url = input.startsWith("/") ? baseUrl + input : input;
      } else if (input instanceof URL) {
        url = input.href;
      } else {
        url = input.url;
      }
      const headers: Record<string, string> = {
        ...(init?.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${token}`,
      };
      return originalFetch(url, { ...init, headers });
    };
  }

  // / 开头路径拼接 baseUrl 并注入 Authorization
  it("prepends baseUrl to / paths and injects Authorization header", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    const spyFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      const h = init?.headers as Record<string, string> | undefined;
      capturedAuth = h?.Authorization ?? "";
      return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const interceptor = createInterceptor("http://rcs-host:3000", "my-secret-token", spyFetch);
    globalThis.fetch = interceptor as unknown as typeof fetch;

    // 模拟 SDK 调用：BaseApi._get 内部调用 fetch("/web/environments", ...)
    await globalThis.fetch("/web/environments");

    expect(capturedUrl).toBe("http://rcs-host:3000/web/environments");
    expect(capturedAuth).toBe("Bearer my-secret-token");
  });

  // 绝对 URL 不拼接 baseUrl
  it("does NOT prepend baseUrl to absolute URLs", async () => {
    let capturedUrl = "";
    const spyFetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const interceptor = createInterceptor("http://rcs-host:3000", "token", spyFetch);
    globalThis.fetch = interceptor as unknown as typeof fetch;

    await globalThis.fetch("https://external-api.com/data");

    expect(capturedUrl).toBe("https://external-api.com/data");
  });

  // URL 对象透传 href
  it("handles URL objects by using href", async () => {
    let capturedUrl = "";
    const spyFetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const interceptor = createInterceptor("http://rcs-host:3000", "token", spyFetch);
    globalThis.fetch = interceptor as unknown as typeof fetch;

    await globalThis.fetch(new URL("https://other.com/path"));

    expect(capturedUrl).toBe("https://other.com/path");
  });

  // Request 对象透传 url
  it("handles Request objects by using url property", async () => {
    let capturedUrl = "";
    const spyFetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const interceptor = createInterceptor("http://rcs-host:3000", "token", spyFetch);
    globalThis.fetch = interceptor as unknown as typeof fetch;

    await globalThis.fetch(new Request("https://other.com/req"));

    expect(capturedUrl).toBe("https://other.com/req");
  });

  // 已有 headers 时合并而非替换
  it("merges with existing headers", async () => {
    let capturedContentType = "";
    let capturedAuth = "";
    const spyFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const h = init?.headers as Record<string, string> | undefined;
      capturedContentType = h?.["Content-Type"] ?? "";
      capturedAuth = h?.Authorization ?? "";
      return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
    }) as unknown as typeof fetch;

    const interceptor = createInterceptor("http://rcs-host:3000", "token", spyFetch);
    globalThis.fetch = interceptor as unknown as typeof fetch;

    await globalThis.fetch("/web/test", { headers: { "Content-Type": "application/json" } });

    expect(capturedContentType).toBe("application/json");
    expect(capturedAuth).toBe("Bearer token");
  });
});

// 缺失环境变量通过子进程测试
describe("bundle-entry env validation", () => {
  const entryPath = import.meta.resolve("../bundle-entry");

  // 缺少 USER_META_BASE_URL 时抛出明确错误
  it("missing USER_META_BASE_URL throws error", async () => {
    const { USER_META_BASE_URL: _, ...envWithoutBaseUrl } = process.env;
    const proc = Bun.spawn(["bun", "-e", `import("${entryPath}")`], {
      cwd: import.meta.dirname,
      env: { ...envWithoutBaseUrl, USER_META_API_KEY: "key" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("USER_META_BASE_URL");
  });

  // 缺少 USER_META_API_KEY 时抛出明确错误
  it("missing USER_META_API_KEY throws error", async () => {
    const { USER_META_API_KEY: _, ...envWithoutApiKey } = process.env;
    const proc = Bun.spawn(["bun", "-e", `import("${entryPath}")`], {
      cwd: import.meta.dirname,
      env: { ...envWithoutApiKey, USER_META_BASE_URL: "http://localhost:3000" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("USER_META_API_KEY");
  });
});

// 环境变量齐全时导出所有预期类（只跑一次，在全局 env 已设置的情况下）
describe("bundle-entry exports", () => {
  process.env.USER_META_BASE_URL = "http://rcs-test:3000";
  process.env.USER_META_API_KEY = "test-secret-token";

  // 导出所有预期类
  it("exports all expected classes", async () => {
    const mod = await import(`../bundle-entry?${Date.now()}`);

    const expectedClasses = [
      "BaseApi",
      "AuthApi",
      "ChannelApi",
      "AgentApi",
      "McpApi",
      "ModelApi",
      "ProviderApi",
      "SkillConfigApi",
      "EnvironmentApi",
      "FileApi",
      "UserFileApi",
      "InstanceApi",
      "KnowledgeBaseApi",
      "MetaAgentApi",
      "ApiKeyApi",
      "OrganizationApi",
      "S3FileApi",
      "ControlApi",
      "SessionApi",
      "TaskApi",
      "V1EnvironmentApi",
      "V1SessionApi",
      "V2CodeSessionApi",
      "V2WorkerApi",
      "WorkflowDefApi",
      "WorkflowEngineApi",
    ];

    for (const name of expectedClasses) {
      expect(mod[name], `expected export "${name}" to exist`).toBeDefined();
      expect(typeof mod[name], `expected "${name}" to be a function`).toBe("function");
    }
  });
});
