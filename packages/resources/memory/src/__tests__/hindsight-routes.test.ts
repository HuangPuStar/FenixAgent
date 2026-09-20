import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubIdentityDirectory } from "@fenix/platform-sdk/testing";
import { createWebHindsightRoutes } from "@fenix/resource-memory/server";
import { initializeMemoryModuleConfig } from "../server/testing";
import { createStubSessionAuthGuardPlugin, type StubHindsightAuthContext } from "./guard-stubs";

/** 测试用 member ID，对应 resolveMemberId 的返回值 */
const TEST_MEMBER_ID = "mem-test-member-id";
/** 测试用 Hindsight URL（写入模块配置，不再经 process.env） */
const TEST_HINDSIGHT_URL = "http://localhost:9999";
/** v1 bank 路径前缀，与后端 bankPath() 一致 */
const BANK_PREFIX = `${TEST_HINDSIGHT_URL}/v1/default/banks/${TEST_MEMBER_ID}`;

describe("web hindsight routes", () => {
  const originalFetch = globalThis.fetch;

  /** 当前用例声明的调用方上下文；切组织即切 bank，由守卫替身按取值函数读取。 */
  let authContext: StubHindsightAuthContext = { organizationId: "test-org", userId: "test-user" };
  /** 用例内构造的路由实例（守卫经工厂注入，与宿主装配路径一致）。 */
  let webHindsight: ReturnType<typeof createWebHindsightRoutes>;

  /** 捕获 proxyToHindsight 发出的 fetch 调用参数 */
  let fetchCalls: { url: string; options?: RequestInit }[] = [];

  beforeEach(() => {
    // 先初始化模块配置：它内部复位全部替身，随后声明的身份目录替身才不会被清掉。
    initializeMemoryModuleConfig({ hindsightMcpUrl: TEST_HINDSIGHT_URL });
    authContext = { organizationId: "test-org", userId: "test-user" };
    fetchCalls = [];

    // Mock fetch：拦截所有发往 Hindsight 的请求
    const mockFetch = async (input: string | URL | Request, options?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push({ url, options });
      return new Response(JSON.stringify({ ok: true, url }), { headers: { "Content-Type": "application/json" } });
    };
    globalThis.fetch = mockFetch as typeof fetch;

    // Stub 身份目录：bank ID 由 resolveMembershipId 解析（不再直查身份表）
    stubIdentityDirectory({
      resolveMembershipId: async () => TEST_MEMBER_ID,
    });

    webHindsight = createWebHindsightRoutes({
      authGuardPlugin: createStubSessionAuthGuardPlugin(() => authContext),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAllStubs();
  });

  // ── Status ──────────────────────────────────────────────

  // 未配置 Hindsight 地址时状态接口仍报告「未启用」，且不解析 bank。
  test("GET /hindsight/status 未配置时返回 enabled: false", async () => {
    initializeMemoryModuleConfig();
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/status"));
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.enabled).toBe(false);
  });

  // 已配置时状态接口返回服务地址与当前用户映射的 bank。
  test("GET /hindsight/status 配置后返回 enabled: true 和 url", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/status"));
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.enabled).toBe(true);
    expect(json.data.url).toBe(TEST_HINDSIGHT_URL);
    expect(json.data.bankId).toBe(TEST_MEMBER_ID);
  });

  // ── Graph ───────────────────────────────────────────────

  // GET /graph 转发到 v1 bank 路径，参数通过 query string，且不写入 method（保持 GET 语义）。
  test("GET /hindsight/graph 转发到 v1 graph 端点", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/graph?type=world&limit=50"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/graph?type=world&limit=50`);
    expect(fetchCalls[0].options?.method).toBeUndefined();
  });

  // ── Bank Stats ──────────────────────────────────────────

  // GET /bank-stats 转发到统计资源。
  test("GET /hindsight/bank-stats 转发到 v1 stats 端点", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/bank-stats"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/stats`);
  });

  // ── Memories ────────────────────────────────────────────

  // GET /memories 使用 list 子资源而不是详情资源。
  test("GET /hindsight/memories 转发到 v1 memories/list", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/memories"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/memories/list`);
  });

  // 列表分页/过滤参数必须原样透传，否则前端筛选会静默失效。
  test("GET /hindsight/memories 透传 query 参数", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/memories?type=world&limit=10&offset=5"),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/memories/list?type=world&limit=10&offset=5`);
  });

  // GET /memories/:id 落到当前 bank 内的记忆详情。
  test("GET /hindsight/memories/:id 转发到 v1 端点", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/memories/mem-abc"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/memories/mem-abc`);
  });

  // 删除记忆必须显式使用 DELETE，不得误发为读取请求。
  test("DELETE /hindsight/memories/:id 使用 DELETE 方法", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/memories/mem-abc", { method: "DELETE" }),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/memories/mem-abc`);
    expect(fetchCalls[0].options?.method).toBe("DELETE");
  });

  // 创建记忆的 body 原样透传：bank 由服务端从上下文解析，客户端不得注入 bank_id 覆盖隔离边界。
  test("POST /hindsight/memories body 直接透传", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ content: "hello" }] }),
      }),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/memories`);
    const body = JSON.parse(fetchCalls[0].options?.body as string);
    expect(body).toEqual({ items: [{ content: "hello" }] });
    expect(body.bank_id).toBeUndefined();
  });

  // ── Recall ──────────────────────────────────────────────

  // 召回走 memories/recall 子资源，body 原样透传。
  test("POST /hindsight/recall 转发到 v1 memories/recall", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/recall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test query" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/memories/recall`);
    const body = JSON.parse(fetchCalls[0].options?.body as string);
    expect(body).toEqual({ query: "test query" });
    expect(body.bank_id).toBeUndefined();
  });

  // ── Reflect ─────────────────────────────────────────────

  // 反思请求（空 JSON body）也必须保留 body 形状并透传。
  test("POST /hindsight/reflect 转发到 v1 reflect", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/reflect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/reflect`);
    const body = JSON.parse(fetchCalls[0].options?.body as string);
    expect(body.bank_id).toBeUndefined();
  });

  // ── Documents ───────────────────────────────────────────

  // 文档列表透传搜索条件。
  test("GET /hindsight/documents 转发到 v1 documents", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/documents"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/documents`);
  });

  // 文档分块查询落在文档子资源下，分页参数透传。
  test("GET /hindsight/documents/:id/chunks 转发到 v1 端点", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/documents/doc-123/chunks"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/documents/doc-123/chunks`);
  });

  // 删除文档使用 DELETE 方法。
  test("DELETE /hindsight/documents/:id 使用 DELETE 方法", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/documents/doc-123", { method: "DELETE" }),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/documents/doc-123`);
    expect(fetchCalls[0].options?.method).toBe("DELETE");
  });

  // ── Mental Models ───────────────────────────────────────

  // 心智模型是独立资源，不与记忆列表混用。
  test("GET /hindsight/mental-models 构造正确路径", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/mental-models"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/mental-models`);
  });

  // 心智模型详情携带模型 ID。
  test("GET /hindsight/mental-models/:id 构造正确路径", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/mental-models/mm-42"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/mental-models/mm-42`);
  });

  // 删除心智模型使用 DELETE 方法。
  test("DELETE /hindsight/mental-models/:id 使用 DELETE 方法", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/mental-models/mm-42", { method: "DELETE" }),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].options?.method).toBe("DELETE");
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/mental-models/mm-42`);
  });

  // ── Entities ────────────────────────────────────────────

  // 实体列表透传上游过滤参数。
  test("GET /hindsight/entities 转发到 v1 entities", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/entities"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/entities`);
  });

  // 实体详情走 ID 资源而不是图谱资源。
  test("GET /hindsight/entities/:id 转发到 v1 端点", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/entities/ent-99"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/entities/ent-99`);
  });

  // 实体图谱的静态路由必须优先于 :id 路由，否则图谱请求会被当成实体 ID。
  test("GET /hindsight/entities/graph 转发到 v1 端点", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/entities/graph?limit=20&min_count=3"),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/entities/graph?limit=20&min_count=3`);
  });

  // 上游资源 id 是不可信输入，必须编码后再拼接：Elysia 会把 %2f 解码进 params，未编码时 `/` 与 `..`
  // 会改变请求路径，而 fetch 会对拼接结果做点段归一化，从而穿透 bank 前缀读到他人 bank 的资源。
  test("GET /hindsight/memories/:id 对含路径分隔符的 id 做编码，不穿透 bank 前缀", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/memories/..%2F..%2Fadmin"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    // 归一化后的路径必须仍落在本 bank 的 memories 资源下（穿透尝试退化为一个普通路径段）。
    expect(new URL(fetchCalls[0].url).pathname.startsWith(`/v1/default/banks/${TEST_MEMBER_ID}/memories/`)).toBe(true);
    expect(fetchCalls[0].url).toContain("..%2F..%2Fadmin");
  });

  // 同一编码口径必须覆盖全部 7 个带 :id 的代理端点，不能只修其中一个。
  // 方法必须与真实定义一致（`documents/:id` 只有 DELETE，没有 GET），否则 404 会让断言恒真。
  test("全部带 :id 的代理端点都转发编码后的路径段", async () => {
    const cases: Array<[string, string]> = [
      ["GET", "memories/..%2Fx"],
      ["DELETE", "memories/..%2Fx"],
      ["DELETE", "documents/..%2Fx"],
      ["GET", "documents/..%2Fx/chunks"],
      ["GET", "mental-models/..%2Fx"],
      ["DELETE", "mental-models/..%2Fx"],
      ["GET", "entities/..%2Fx"],
    ];
    for (const [method, path] of cases) {
      fetchCalls = [];
      const response = await webHindsight.handle(new Request(`http://localhost/hindsight/${path}`, { method }));
      expect([method, path, response.status]).toEqual([method, path, 200]);
      expect(fetchCalls).toHaveLength(1);
      expect(new URL(fetchCalls[0].url).pathname.startsWith(`/v1/default/banks/${TEST_MEMBER_ID}/`)).toBe(true);
    }
  });
});
