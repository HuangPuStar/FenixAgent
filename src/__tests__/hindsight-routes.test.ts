import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import webHindsight from "../routes/web/hindsight";
import { clearOrgCache, setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

/** 测试用 member ID，对应 resolveMemberId 的返回值 */
const TEST_MEMBER_ID = "mem-test-member-id";
/** 测试用 Hindsight URL */
const TEST_HINDSIGHT_URL = "http://localhost:9999";

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
    // resolveMemberId 调用链: db.select({id}).from(member).where(...).limit(1)
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

  // ── Memories ────────────────────────────────────────────

  // GET /memories 正确注入 bank_id 并转发到 /api/list
  test("GET /hindsight/members 注入 bank_id 并转发", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/memories"));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(true);
    // fetch 应被调用一次，URL 包含 /api/list 且 bank_id=TEST_MEMBER_ID
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/api/list?");
    expect(fetchCalls[0].url).toContain(`bank_id=${TEST_MEMBER_ID}`);
  });

  // GET /memories/:id 正确注入 bank_id 到查询参数
  test("GET /hindsight/memories/:id 注入 bank_id", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/memories/mem-abc"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/api/memories/mem-abc?");
    expect(fetchCalls[0].url).toContain(`bank_id=${TEST_MEMBER_ID}`);
  });

  // DELETE /memories/:id 发送 DELETE 方法
  test("DELETE /hindsight/memories/:id 使用 DELETE 方法", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/memories/mem-abc", { method: "DELETE" }),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].options?.method).toBe("DELETE");
    expect(fetchCalls[0].url).toContain(`bank_id=${TEST_MEMBER_ID}`);
  });

  // POST /memories 在 body 中注入 bank_id
  test("POST /hindsight/memories 在 body 中注入 bank_id", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/memories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/api/memories/retain");
    const body = JSON.parse(fetchCalls[0].options?.body as string);
    expect(body.bank_id).toBe(TEST_MEMBER_ID);
    expect(body.content).toBe("hello");
  });

  // ── Recall ──────────────────────────────────────────────

  // POST /recall 在 body 中注入 bank_id
  test("POST /hindsight/recall 注入 bank_id 并转发", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/recall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test query" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/api/recall");
    const body = JSON.parse(fetchCalls[0].options?.body as string);
    expect(body.bank_id).toBe(TEST_MEMBER_ID);
    expect(body.query).toBe("test query");
  });

  // ── Reflect ─────────────────────────────────────────────

  // POST /reflect 在 body 中注入 bank_id
  test("POST /hindsight/reflect 注入 bank_id 并转发", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/reflect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/api/reflect");
    const body = JSON.parse(fetchCalls[0].options?.body as string);
    expect(body.bank_id).toBe(TEST_MEMBER_ID);
  });

  // ── Documents ───────────────────────────────────────────

  // GET /documents 注入 bank_id 到查询参数
  test("GET /hindsight/documents 注入 bank_id 并转发", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/documents"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/api/documents?");
    expect(fetchCalls[0].url).toContain(`bank_id=${TEST_MEMBER_ID}`);
  });

  // GET /documents/:id/chunks 注入 bank_id
  test("GET /hindsight/documents/:id/chunks 注入 bank_id", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/documents/doc-123/chunks"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain("/api/documents/doc-123/chunks?");
    expect(fetchCalls[0].url).toContain(`bank_id=${TEST_MEMBER_ID}`);
  });

  // DELETE /documents/:id 使用 DELETE 方法
  test("DELETE /hindsight/documents/:id 使用 DELETE 方法", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/documents/doc-123", { method: "DELETE" }),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].options?.method).toBe("DELETE");
    expect(fetchCalls[0].url).toContain(`bank_id=${TEST_MEMBER_ID}`);
  });

  // ── Mental Models ───────────────────────────────────────

  // GET /mental-models 构造正确的 v1 API 路径
  test("GET /hindsight/mental-models 构造正确路径", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/mental-models"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${TEST_HINDSIGHT_URL}/v1/default/banks/${TEST_MEMBER_ID}/mental-models`);
  });

  // GET /mental-models/:id 包含 bankId 和 model ID
  test("GET /hindsight/mental-models/:id 构造正确路径", async () => {
    const response = await webHindsight.handle(new Request("http://localhost/hindsight/mental-models/mm-42"));
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(`${TEST_HINDSIGHT_URL}/v1/default/banks/${TEST_MEMBER_ID}/mental-models/mm-42`);
  });

  // DELETE /mental-models/:id 使用 DELETE 方法
  test("DELETE /hindsight/mental-models/:id 使用 DELETE 方法", async () => {
    const response = await webHindsight.handle(
      new Request("http://localhost/hindsight/mental-models/mm-42", { method: "DELETE" }),
    );
    expect(response.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].options?.method).toBe("DELETE");
    expect(fetchCalls[0].url).toBe(`${TEST_HINDSIGHT_URL}/v1/default/banks/${TEST_MEMBER_ID}/mental-models/mm-42`);
  });
});
