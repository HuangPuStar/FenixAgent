import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import hindsightRoutes from "../routes/web/hindsight";
import { readJson, resetAllStubs, stubAuthApi, stubDb } from "../test-utils/helpers";

type FetchCall = { url: string; init?: RequestInit };

const hindsightUrl = "http://hindsight.test";
let memberId: string | null = "member-org-a";
let calls: FetchCall[] = [];
let upstream: () => Promise<Response> = async () => Response.json({ source: "hindsight" });
const originalFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");

function request(path: string, init?: RequestInit) {
  return hindsightRoutes.handle(new Request(`http://localhost${path}`, init));
}

function jsonRequest(path: string, body: unknown) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function authenticate(organizationId = "org-a") {
  setTestAuth({
    user: { id: "user-a", email: "user-a@example.test", name: "测试用户" },
    authContext: { organizationId, userId: "user-a", role: "member" },
  });
}

function latestCall() {
  const call = calls.at(-1);
  expect(call).toBeDefined();
  return call!;
}

describe("round60 hindsight 路由", () => {
  beforeEach(() => {
    resetAllStubs();
    process.env.HINDSIGHT_MCP_URL = hindsightUrl;
    memberId = "member-org-a";
    calls = [];
    upstream = async () => Response.json({ source: "hindsight" });
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => (memberId ? [{ id: memberId }] : []) }),
        }),
      }),
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        calls.push({ url, init });
        return upstream();
      },
    });
    authenticate();
  });

  afterEach(() => {
    resetTestAuth();
    resetAllStubs();
    if (originalFetchDescriptor) Object.defineProperty(globalThis, "fetch", originalFetchDescriptor);
    delete process.env.HINDSIGHT_MCP_URL;
  });

  // 未认证的业务读取必须由 sessionAuth 拒绝，且不得访问上游。
  test("未认证 graph 返回 401", async () => {
    resetTestAuth();
    stubAuthApi({ getSession: async () => null, verifyApiKey: async () => ({ valid: false }) });
    expect((await request("/hindsight/graph")).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  // 未配置服务时状态接口仍可安全报告禁用。
  test("未配置时 status 返回 disabled", async () => {
    delete process.env.HINDSIGHT_MCP_URL;
    const body = await (await request("/hindsight/status")).json();
    expect(body).toEqual({ success: true, data: { enabled: false } });
  });

  // 状态接口不要求认证时仅返回服务配置，不解析当前组织 bank，并且不触发上游调用。
  test("已配置时 status 返回服务地址且不带组织 bank", async () => {
    const body = await (await request("/hindsight/status")).json();
    expect(body).toEqual({ success: true, data: { enabled: true, url: hindsightUrl, bankId: null } });
    expect(calls).toHaveLength(0);
  });

  // 图谱查询应把筛选条件安全编码后透传给当前组织的 bank。
  test("graph 转发查询参数", async () => {
    expect((await request("/hindsight/graph?tag=A%26B&limit=2")).status).toBe(200);
    expect(latestCall().url).toBe(`${hindsightUrl}/v1/default/banks/member-org-a/graph?tag=A%26B&limit=2`);
  });

  // 同一用户切换组织后必须使用该组织对应的独立 bank。
  test("graph 使用切换组织后的 bank", async () => {
    memberId = "member-org-b";
    authenticate("org-b");
    await request("/hindsight/graph");
    expect(latestCall().url).toBe(`${hindsightUrl}/v1/default/banks/member-org-b/graph`);
  });

  // 未找到组织成员映射时，不能退化到共享或用户级 bank。
  test("graph 无成员映射返回 403", async () => {
    memberId = null;
    const response = await request("/hindsight/graph");
    expect(response.status).toBe(403);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "forbidden", message: "Cannot resolve bank ID" },
    });
    expect(calls).toHaveLength(0);
  });

  // 上游故障应映射为稳定的服务不可用响应。
  test("graph 上游失败返回 503", async () => {
    upstream = async () => Promise.reject(new Error("offline"));
    const response = await request("/hindsight/graph");
    expect(response.status).toBe(503);
    expect(await readJson(response)).toMatchObject({ error: { code: "service_unavailable" } });
  });

  // 统计读取应定位到当前 bank 的 stats 资源。
  test("bank-stats 转发到统计资源", async () => {
    await request("/hindsight/bank-stats");
    expect(latestCall().url).toBe(`${hindsightUrl}/v1/default/banks/member-org-a/stats`);
  });

  // 记忆列表应保留分页参数并使用 list 子资源。
  test("memories 列表转发分页参数", async () => {
    await request("/hindsight/memories?offset=3&limit=7");
    expect(latestCall().url).toBe(`${hindsightUrl}/v1/default/banks/member-org-a/memories/list?offset=3&limit=7`);
  });

  // 记忆详情必须限定在当前 bank 内。
  test("memory 详情转发到当前 bank", async () => {
    await request("/hindsight/memories/memory-1");
    expect(latestCall().url).toBe(`${hindsightUrl}/v1/default/banks/member-org-a/memories/memory-1`);
  });

  // 删除记忆必须显式使用 DELETE，不得误发为读取请求。
  test("memory 删除使用 DELETE", async () => {
    await request("/hindsight/memories/memory-1", { method: "DELETE" });
    expect(latestCall().init?.method).toBe("DELETE");
  });

  // 创建记忆应以 JSON 原样转发，不能由客户端指定 bank_id 覆盖隔离边界。
  test("memory 创建保留业务体", async () => {
    await jsonRequest("/hindsight/memories", { items: [{ content: "保密记忆" }] });
    const call = latestCall();
    expect(call.init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(call.init?.body).toBe('{"items":[{"content":"保密记忆"}]}');
  });

  // 召回应进入 memories/recall 而非通用创建端点。
  test("recall 转发到语义召回资源", async () => {
    await jsonRequest("/hindsight/recall", { query: "项目计划" });
    expect(latestCall().url).toBe(`${hindsightUrl}/v1/default/banks/member-org-a/memories/recall`);
  });

  // 反思请求应保留空对象这类合法 JSON body。
  test("reflect 转发空 JSON body", async () => {
    await jsonRequest("/hindsight/reflect", {});
    const call = latestCall();
    expect(call.url).toBe(`${hindsightUrl}/v1/default/banks/member-org-a/reflect`);
    expect(call.init?.body).toBe("{}");
  });

  // 文档列表应将搜索条件透传到当前 bank。
  test("documents 列表转发查询条件", async () => {
    await request("/hindsight/documents?source=wiki");
    expect(latestCall().url).toBe(`${hindsightUrl}/v1/default/banks/member-org-a/documents?source=wiki`);
  });

  // 上传文档时仅重建字符串和 Blob 字段，避免把未知值发往上游。
  test("documents 上传重建 multipart body", async () => {
    const form = new FormData();
    form.set("title", "设计稿");
    form.set("file", new Blob(["正文"], { type: "text/plain" }), "note.txt");
    await request("/hindsight/documents", { method: "POST", body: form });
    const body = latestCall().init?.body;
    expect(body).toBeInstanceOf(FormData);
    const forwarded = body as FormData;
    expect(forwarded.get("title")).toBe("设计稿");
    expect(forwarded.get("file")).toBeInstanceOf(Blob);
  });

  // 文档删除需使用当前 bank 下的 DELETE 资源。
  test("documents 删除使用 DELETE", async () => {
    await request("/hindsight/documents/doc-1", { method: "DELETE" });
    const call = latestCall();
    expect(call.url).toBe(`${hindsightUrl}/v1/default/banks/member-org-a/documents/doc-1`);
    expect(call.init?.method).toBe("DELETE");
  });

  // 文档分块查询应保留分页 query。
  test("documents chunks 转发查询参数", async () => {
    await request("/hindsight/documents/doc-1/chunks?limit=5");
    expect(latestCall().url).toBe(`${hindsightUrl}/v1/default/banks/member-org-a/documents/doc-1/chunks?limit=5`);
  });

  // 心智模型列表是独立资源，不应和记忆列表混用。
  test("mental-models 列表转发独立资源", async () => {
    await request("/hindsight/mental-models");
    expect(latestCall().url).toBe(`${hindsightUrl}/v1/default/banks/member-org-a/mental-models`);
  });

  // 心智模型详情必须携带模型 ID。
  test("mental-model 详情转发模型 ID", async () => {
    await request("/hindsight/mental-models/model-1");
    expect(latestCall().url).toBe(`${hindsightUrl}/v1/default/banks/member-org-a/mental-models/model-1`);
  });

  // 删除心智模型应明确使用 DELETE。
  test("mental-model 删除使用 DELETE", async () => {
    await request("/hindsight/mental-models/model-1", { method: "DELETE" });
    expect(latestCall().init?.method).toBe("DELETE");
  });

  // 实体列表支持上游过滤参数。
  test("entities 列表转发过滤条件", async () => {
    await request("/hindsight/entities?kind=person");
    expect(latestCall().url).toBe(`${hindsightUrl}/v1/default/banks/member-org-a/entities?kind=person`);
  });

  // 实体详情应走 ID 资源而不是图谱资源。
  test("entity 详情转发实体 ID", async () => {
    await request("/hindsight/entities/entity-1");
    expect(latestCall().url).toBe(`${hindsightUrl}/v1/default/banks/member-org-a/entities/entity-1`);
  });

  // 实体图谱的静态路由应优先于 :id 路由。
  test("entities graph 命中图谱资源", async () => {
    await request("/hindsight/entities/graph?min_count=2");
    expect(latestCall().url).toBe(`${hindsightUrl}/v1/default/banks/member-org-a/entities/graph?min_count=2`);
  });

  // 读取文档前无法解析成员时必须拒绝访问上游。
  test("documents 无成员映射返回 403", async () => {
    memberId = null;
    expect((await request("/hindsight/documents")).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  // 写入记忆前无法解析成员时必须拒绝写入。
  test("memory 创建无成员映射返回 403", async () => {
    memberId = null;
    expect((await jsonRequest("/hindsight/memories", { items: [] })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  // 上传文档遇到上游异常时必须隐藏内部错误细节。
  test("documents 上传上游失败返回 503", async () => {
    upstream = async () => Promise.reject(new Error("connection refused"));
    const form = new FormData();
    form.set("title", "不可用测试");
    const response = await request("/hindsight/documents", { method: "POST", body: form });
    expect(response.status).toBe(503);
    expect(await readJson(response)).toMatchObject({
      error: { code: "service_unavailable", message: "Hindsight service unavailable" },
    });
  });

  // 心智模型删除的上游异常也应使用统一错误映射。
  test("mental-model 删除上游失败返回 503", async () => {
    upstream = async () => Promise.reject(new Error("timeout"));
    const response = await request("/hindsight/mental-models/model-1", { method: "DELETE" });
    expect(response.status).toBe(503);
    expect(await readJson(response)).toMatchObject({ error: { code: "service_unavailable" } });
  });

  // 实体图谱在上游不可用时不应泄露原始异常。
  test("entities graph 上游失败返回 503", async () => {
    upstream = async () => Promise.reject(new Error("network secret"));
    const response = await request("/hindsight/entities/graph");
    expect(response.status).toBe(503);
    expect(await readJson(response)).toMatchObject({
      error: { message: "Hindsight service unavailable" },
    });
  });
});
