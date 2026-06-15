import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import webHindsight from "../routes/web/hindsight";
import { clearOrgCache, setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

/** 测试用 member ID，对应 resolveMemberId 的返回值 */
const TEST_MEMBER_ID = "mem-test-member-id";
/** 测试用 Hindsight URL */
const TEST_HINDSIGHT_URL = "http://localhost:9999";
/** v1 bank 路径前缀，与后端 bankPath() 一致 */
const BANK_PREFIX = `${TEST_HINDSIGHT_URL}/v1/default/banks/${TEST_MEMBER_ID}`;

describe("web hindsight routes", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  /** 捕获 proxyToHindsight 发出的 fetch 调用参数 */
  let fetchCalls: { url: string; options?: RequestInit }[] = [];

  beforeEach(() => {
    resetAllStubs();
    process.env.HINDSIGHT_MCP_URL = TEST_HINDSIGHT_URL;
    fetchCalls = [];

    // Mock fetch：拦截所有发往 Hindsight 的请求
    const mockFetch = async (input: string | URL | Request, options?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push({ url, options });
      return new Response(JSON.stringify({ ok: true, url }), { headers: { "Content-Type": "application/json" } });
    };
    globalThis.fetch = mockFetch as typeof fetch;

    // Stub db：让 resolveMemberId 返回 TEST_MEMBER_ID
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ id: TEST_MEMBER_ID }]),
          }),
        }),
      }),
    });

    // 注入测试认证上下文
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: { organizationId: "test-org", userId: "test-user", role: "owner" },
    });
    setTestOrgContext({ organizationId: "test-org", userId: "test-user", role: "owner" });
  });

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
    globalThis.fetch = originalFetch;
    resetTestAuth();
    setTestOrgContext(null);
    clearOrgCache();
  });

  // ── Status ──────────────────────────────────────────────

  test("GET /hindsight/status 未配置时返回 enabled: false", async () => {
    delete process.env.HINDSIGHT_MCP_URL;
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/status"));
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.enabled).toBe(false);
  });

  test("GET /hindsight/status 配置后返回 enabled: true 和 url", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/status"));
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.data.enabled).toBe(true);
    expect(json.data.url).toBe(TEST_HINDSIGHT_URL);
  });

  // ── Graph ───────────────────────────────────────────────

  // GET /graph 转发到 v1 bank 路径，参数通过 query string
  test("GET /hindsight/graph 转发到 v1 graph 端点", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/graph?type=world&limit=50"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/graph?type=world&limit=50`);
    // GET 方法，不应有 options.method
    expect(fetchCalls[0].options?.method).toBeUndefined();
  });

  // ── Bank Stats ──────────────────────────────────────────

  // GET /bank-stats 转发到 v1 stats 端点
  test("GET /hindsight/bank-stats 转发到 v1 stats 端点", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/bank-stats"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/stats`);
  });

  // ── Memories ────────────────────────────────────────────

  // GET /memories 转发到 v1 memories/list 端点
  test("GET /hindsight/memories 转发到 v1 memories/list", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/memories"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/memories/list`);
  });

  // GET /memories 带 query 参数透传
  test("GET /hindsight/memories 透传 query 参数", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/memories?type=world&limit=10&offset=5"),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/memories/list?type=world&limit=10&offset=5`);
  });

  // GET /memories/:id 转发到 v1 memories/{id}
  test("GET /hindsight/memories/:id 转发到 v1 端点", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/memories/mem-abc"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/memories/mem-abc`);
  });

  // DELETE /memories/:id 使用 DELETE 方法
  test("DELETE /hindsight/memories/:id 使用 DELETE 方法", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/memories/mem-abc", { method: "DELETE" }),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/memories/mem-abc`);
    expect(fetchCalls[0].options?.method).toBe("DELETE");
  });

  // POST /memories body 直接透传，不再注入 bank_id
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
    // body 直接透传，不应包含 bank_id
    expect(body).toEqual({ items: [{ content: "hello" }] });
    expect(body.bank_id).toBeUndefined();
  });

  // ── Recall ──────────────────────────────────────────────

  // POST /recall 转发到 v1 memories/recall，body 直接透传
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

  // POST /reflect 转发到 v1 reflect，body 直接透传
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

  // GET /documents 转发到 v1 documents 端点
  test("GET /hindsight/documents 转发到 v1 documents", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/documents"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/documents`);
  });

  // GET /documents/:id/chunks 转发到 v1 端点
  test("GET /hindsight/documents/:id/chunks 转发到 v1 端点", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/documents/doc-123/chunks"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/documents/doc-123/chunks`);
  });

  // DELETE /documents/:id 使用 DELETE 方法
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

  // GET /mental-models 构造正确的 v1 API 路径
  test("GET /hindsight/mental-models 构造正确路径", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/mental-models"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/mental-models`);
  });

  // GET /mental-models/:id 包含 bankId 和 model ID
  test("GET /hindsight/mental-models/:id 构造正确路径", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/mental-models/mm-42"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/mental-models/mm-42`);
  });

  // DELETE /mental-models/:id 使用 DELETE 方法
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

  // GET /entities 转发到 v1 entities 端点
  test("GET /hindsight/entities 转发到 v1 entities", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/entities"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/entities`);
  });

  // GET /entities/:id 转发到 v1 端点
  test("GET /hindsight/entities/:id 转发到 v1 端点", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/entities/ent-99"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/entities/ent-99`);
  });

  // GET /entities/graph 转发到 v1 端点
  test("GET /hindsight/entities/graph 转发到 v1 端点", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/entities/graph?limit=20&min_count=3"),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${BANK_PREFIX}/entities/graph?limit=20&min_count=3`);
  });
});
