import { afterEach, describe, expect, it, mock } from "bun:test";
import { BaseApi } from "../base";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("BaseApi.replaceParams", () => {
  it("替换单个参数", () => {
    const api = new BaseApi();
    const result = api["replaceParams"]("/web/sessions/:sessionId/events", {
      sessionId: "ses_123",
    });
    expect(result).toBe("/web/sessions/ses_123/events");
  });

  it("替换多个参数", () => {
    const api = new BaseApi();
    const result = api["replaceParams"]("/v1/:orgId/:userId/profile", {
      orgId: "org_1",
      userId: "usr_2",
    });
    expect(result).toBe("/v1/org_1/usr_2/profile");
  });

  it("无参数路径原样返回", () => {
    const api = new BaseApi();
    const result = api["replaceParams"]("/web/environments", {});
    expect(result).toBe("/web/environments");
  });
});

describe("BaseApi.get — 成功响应", () => {
  it("解包 { success: true, data } 格式", async () => {
    const api = new BaseApi();
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: true, data: { id: "1", name: "test" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    const result = await api["get"]<{ id: string; name: string }>("/web/environments");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.id).toBe("1");
      expect(result.data.name).toBe("test");
    }
  });

  it("非标准格式直接返回", async () => {
    const api = new BaseApi();
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "ok", version: "1.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    const result = await api["get"]<{ status: string; version: string }>("/health");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.version).toBe("1.0");
    }
  });
});

describe("BaseApi.post — 错误响应", () => {
  it("解包 { success: false, error } 格式", async () => {
    const api = new BaseApi();
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "资源不存在" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    const result = await api["post"]("/web/environments", { name: "test" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toBe("资源不存在");
    }
  });

  it("HTTP 错误无 JSON body 时返回 statusText", async () => {
    const api = new BaseApi();
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    ) as unknown as typeof fetch;

    const result = await api["post"]<never>("/web/test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe(500);
    }
  });
});
