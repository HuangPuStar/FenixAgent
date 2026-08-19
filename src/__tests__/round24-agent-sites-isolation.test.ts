import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AgentSitesError,
  createRemoteApp,
  deleteRemoteApp,
  deployCustomApp,
  isAgentSitesConfigured,
  issuePlatformToken,
  proxyToAgentSites,
  revokePlatformToken,
  uploadRemoteBundle,
  uploadRemoteFile,
} from "../services/agent-sites";

const ORIGINAL_ENV = {
  baseUrl: process.env.AGENT_SITES_BASE_URL,
  masterKey: process.env.AGENT_SITES_MASTER_KEY,
};
let originalFetch: typeof fetch;
let requests: Array<{ url: string; init: RequestInit | undefined }>;
let responseFactory: () => Response;

function restoreEnv(name: "AGENT_SITES_BASE_URL" | "AGENT_SITES_MASTER_KEY", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function successfulJson(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

function capturedHeaders(index = 0): Headers {
  return new Headers(requests[index]?.init?.headers);
}

beforeEach(() => {
  process.env.AGENT_SITES_BASE_URL = "https://agent-sites.test";
  process.env.AGENT_SITES_MASTER_KEY = "test-master-key";
  requests = [];
  responseFactory = () => successfulJson({ data: {} });
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ url: input.toString(), init });
    return responseFactory();
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("AGENT_SITES_BASE_URL", ORIGINAL_ENV.baseUrl);
  restoreEnv("AGENT_SITES_MASTER_KEY", ORIGINAL_ENV.masterKey);
});

describe("agent-sites 隔离客户端边界", () => {
  // 未配置基础地址时必须在发起远程请求前失败。
  test("缺少基础地址拒绝创建远程应用", async () => {
    delete process.env.AGENT_SITES_BASE_URL;
    await expect(createRemoteApp("演示应用")).rejects.toThrow("AGENT_SITES_BASE_URL not configured");
    expect(requests).toHaveLength(0);
  });

  // 未配置主密钥时不得尝试无鉴权调用平台。
  test("缺少主密钥拒绝创建远程应用", async () => {
    delete process.env.AGENT_SITES_MASTER_KEY;
    await expect(createRemoteApp("演示应用")).rejects.toThrow("AGENT_SITES_MASTER_KEY not configured");
    expect(requests).toHaveLength(0);
  });

  // 两项配置同时存在才报告客户端可用。
  test("完整配置报告可用", () => {
    expect(isAgentSitesConfigured()).toBe(true);
  });

  // 缺少基础地址时配置状态必须为不可用。
  test("缺少基础地址报告不可用", () => {
    delete process.env.AGENT_SITES_BASE_URL;
    expect(isAgentSitesConfigured()).toBe(false);
  });

  // 缺少主密钥时配置状态必须为不可用。
  test("缺少主密钥报告不可用", () => {
    delete process.env.AGENT_SITES_MASTER_KEY;
    expect(isAgentSitesConfigured()).toBe(false);
  });

  // 创建默认应用不得擅自标记为 custom 类型。
  test("创建默认 PocketBase 应用", async () => {
    responseFactory = () => successfulJson({ data: { id: "app-1", type: "pocketbase" } });
    await expect(createRemoteApp("默认应用")).resolves.toEqual({ id: "app-1", type: "pocketbase" });
    expect(requests[0]?.url).toBe("https://agent-sites.test/api/apps");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ name: "默认应用" });
  });

  // custom 类型必须明确传递给平台。
  test("创建 custom 应用传递类型", async () => {
    await createRemoteApp("自定义应用", "custom");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ name: "自定义应用", type: "custom" });
  });

  // 平台管理请求必须携带主密钥。
  test("创建应用注入主密钥", async () => {
    await createRemoteApp("鉴权应用");
    expect(capturedHeaders().get("x-master-key")).toBe("test-master-key");
  });

  // JSON 管理请求需要默认内容类型。
  test("创建应用注入 JSON 内容类型", async () => {
    await createRemoteApp("内容类型应用");
    expect(capturedHeaders().get("content-type")).toBe("application/json");
  });

  // 删除请求必须对路径参数编码，防止路径穿透。
  test("删除应用编码应用标识", async () => {
    await deleteRemoteApp("app/a b");
    expect(requests[0]?.url).toBe("https://agent-sites.test/api/apps/app%2Fa%20b");
  });

  // DELETE 管理请求仍需主密钥和 JSON 内容类型。
  test("删除应用保留管理鉴权", async () => {
    await deleteRemoteApp("app-1");
    expect(requests[0]?.init?.method).toBe("DELETE");
    expect(capturedHeaders().get("x-master-key")).toBe("test-master-key");
    expect(capturedHeaders().get("content-type")).toBe("application/json");
  });

  // token 申请只发送目标应用标识。
  test("申请平台令牌传递应用标识", async () => {
    responseFactory = () => successfulJson({ data: { token_id: "token-1", app_id: "app-1", token: "opaque" } });
    await expect(issuePlatformToken("app-1")).resolves.toEqual({
      token_id: "token-1",
      app_id: "app-1",
      token: "opaque",
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ app_id: "app-1" });
  });

  // 吊销令牌必须编码标识且使用 DELETE。
  test("吊销令牌编码令牌标识", async () => {
    await revokePlatformToken("token/a b");
    expect(requests[0]?.url).toBe("https://agent-sites.test/api/tokens/token%2Fa%20b");
    expect(requests[0]?.init?.method).toBe("DELETE");
  });

  // 单文件上传必须透传流资源并使用平台默认 JSON 内容类型。
  test("上传单文件保留流资源", async () => {
    const body = new ReadableStream<Uint8Array>();
    await uploadRemoteFile("app-1", "assets/a b.js", body);
    expect(requests[0]?.url).toBe("https://agent-sites.test/api/apps/app-1/files/assets%2Fa%20b.js");
    expect(requests[0]?.init?.method).toBe("PUT");
    expect(capturedHeaders().get("content-type")).toBe("application/json");
    expect(requests[0]?.init?.body).toBe(body);
  });

  // bundle 上传必须编码应用标识并原样透传流。
  test("上传 bundle 保留流资源", async () => {
    const body = new ReadableStream<Uint8Array>();
    await uploadRemoteBundle("app/a", body);
    expect(requests[0]?.url).toBe("https://agent-sites.test/api/apps/app%2Fa/files/bundle");
    expect(requests[0]?.init?.body).toBe(body);
  });

  // custom 部署应复用同一受控上传通道。
  test("部署 custom 应用编码标识", async () => {
    const body = new ReadableStream<Uint8Array>();
    await deployCustomApp("app/a", body);
    expect(requests[0]?.url).toBe("https://agent-sites.test/api/apps/app%2Fa/deploy");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requests[0]?.init?.body).toBe(body);
  });

  // 平台错误中的嵌套信息应转为可诊断错误。
  test("嵌套平台错误映射为 AgentSitesError", async () => {
    responseFactory = () => successfulJson({ error: { message: "名称已存在" } });
    responseFactory = () => new Response(JSON.stringify({ error: { message: "名称已存在" } }), { status: 409 });
    await expect(createRemoteApp("重复应用")).rejects.toEqual(
      expect.objectContaining({ status: 409, message: "名称已存在" }),
    );
  });

  // 平台错误可回退到顶层 message。
  test("顶层平台错误消息被保留", async () => {
    responseFactory = () => new Response(JSON.stringify({ message: "请求无效" }), { status: 400 });
    await expect(deleteRemoteApp("app-1")).rejects.toEqual(
      expect.objectContaining({ status: 400, message: "请求无效" }),
    );
  });

  // 非 JSON 错误体不能掩盖状态文本。
  test("非 JSON 错误使用状态文本", async () => {
    responseFactory = () => new Response("not-json", { status: 503, statusText: "Service Unavailable" });
    await expect(revokePlatformToken("token-1")).rejects.toEqual(
      expect.objectContaining({ status: 503, message: "Service Unavailable" }),
    );
  });

  // 错误对象应保留专用类型，便于调用方按状态处理。
  test("平台错误保留 AgentSitesError 类型", async () => {
    responseFactory = () => new Response("", { status: 401, statusText: "Unauthorized" });
    await expect(issuePlatformToken("app-1")).rejects.toBeInstanceOf(AgentSitesError);
  });

  // GET 代理不能把请求体转交给下游。
  test("GET 代理不转发请求体", async () => {
    const request = new Request("https://rcs.test/api?tag=one", {
      headers: { authorization: "Bearer platform-token" },
    });
    await proxyToAgentSites("app-1", "/api/items", request);
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[0]?.init?.body).toBeUndefined();
  });

  // HEAD 代理同样不得持有请求体资源。
  test("HEAD 代理不转发请求体", async () => {
    const request = new Request("https://rcs.test/api", { method: "HEAD" });
    await proxyToAgentSites("app-1", "/health", request);
    expect(requests[0]?.init?.body).toBeUndefined();
  });

  // 非 GET 请求必须原样交接流，避免提前消费上传资源。
  test("POST 代理透传请求体流", async () => {
    const request = new Request("https://rcs.test/api", { method: "POST", body: "payload" });
    await proxyToAgentSites("app-1", "/submit", request);
    expect(requests[0]?.init?.body).toBe(request.body);
  });

  // 上游查询参数必须保留，但不得覆盖固定代理路径。
  test("代理保留查询参数", async () => {
    await proxyToAgentSites("app-1", "/api/items?fixed=yes", new Request("https://rcs.test/source?tag=one&tag=two"));
    expect(requests[0]?.url).toBe("https://agent-sites.test/app-1/api/items?fixed=yes&tag=two");
  });

  // appId 必须编码以隔离平台路由边界。
  test("代理编码应用标识", async () => {
    await proxyToAgentSites("app/a b", "/api", new Request("https://rcs.test/source"));
    expect(requests[0]?.url).toBe("https://agent-sites.test/app%2Fa%20b/api");
  });

  // RCS Host 头不能泄露到下游服务。
  test("代理剥离 Host 请求头", async () => {
    await proxyToAgentSites(
      "app-1",
      "/api",
      new Request("https://rcs.test/source", { headers: { host: "internal.rcs" } }),
    );
    expect(capturedHeaders().get("host")).toBeNull();
  });

  // RCS 会话 cookie 不得跨服务泄露。
  test("代理剥离 RCS 会话 cookie", async () => {
    await proxyToAgentSites(
      "app-1",
      "/api",
      new Request("https://rcs.test/source", { headers: { cookie: "session=secret" } }),
    );
    expect(capturedHeaders().get("cookie")).toBeNull();
  });

  // L2 令牌由调用方负责，代理不得注入 L1 主密钥。
  test("代理不泄露主密钥", async () => {
    await proxyToAgentSites("app-1", "/api", new Request("https://rcs.test/source"));
    expect(capturedHeaders().get("x-master-key")).toBeNull();
  });

  // 显式附加头应覆盖来源头，实现下游身份隔离。
  test("代理附加头覆盖来源认证", async () => {
    await proxyToAgentSites(
      "app-1",
      "/api",
      new Request("https://rcs.test/source", { headers: { authorization: "Bearer stale" } }),
      { authorization: "Bearer scoped" },
    );
    expect(capturedHeaders().get("authorization")).toBe("Bearer scoped");
  });

  // 代理响应须移除已解码的内容编码，防止客户端二次解压。
  test("代理响应剥离内容编码", async () => {
    responseFactory = () =>
      new Response("decoded", { headers: { "content-encoding": "gzip", "transfer-encoding": "chunked", etag: "v1" } });
    const response = await proxyToAgentSites("app-1", "/api", new Request("https://rcs.test/source"));
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("transfer-encoding")).toBeNull();
    expect(response.headers.get("etag")).toBe("v1");
  });

  // 客户端中断应转成 499 而非误报平台故障。
  test("代理将 AbortError 映射为客户端关闭", async () => {
    globalThis.fetch = async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    };
    const response = await proxyToAgentSites("app-1", "/api", new Request("https://rcs.test/source"));
    expect(response.status).toBe(499);
    expect(response.statusText).toBe("Client Closed Request");
  });

  // 未知连接失败必须映射为受控网关错误。
  test("代理将连接失败映射为网关错误", async () => {
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };
    const response = await proxyToAgentSites("app-1", "/api", new Request("https://rcs.test/source"));
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { type: "bad_gateway", message: "Agent Sites unreachable: connection refused" },
    });
  });

  // 非 Error 异常也必须安全转换为可返回的网关错误。
  test("代理处理非 Error 失败", async () => {
    globalThis.fetch = async () => {
      throw "offline";
    };
    const response = await proxyToAgentSites("app-1", "/api", new Request("https://rcs.test/source"));
    await expect(response.json()).resolves.toEqual({
      error: { type: "bad_gateway", message: "Agent Sites unreachable: offline" },
    });
  });
});
