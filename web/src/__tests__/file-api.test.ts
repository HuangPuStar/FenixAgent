import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { client, fetchUpload } from "../api/client";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Mock fetch globally
let mockFetchCalls: Array<{ url: string; method: string; headers?: Record<string, string>; body?: any }> = [];

const originalFetch = globalThis.fetch;

describe("File API Functions (Eden Treaty)", () => {
  beforeEach(() => {
    mockFetchCalls = [];
    globalThis.fetch = async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.toString();
      mockFetchCalls.push({
        url,
        method: init?.method || "GET",
        headers: init?.headers,
        body: init?.body,
      });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Map([["content-type", "application/json"]]),
        json: async () => ({ success: true }),
        text: async () => JSON.stringify({ success: true }),
      } as any;
    };
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  // 测试列出文件不带目录参数
  test("listFiles — no path param", async () => {
    await client.web.sessions({ id: "s1" }).user.get();
    expect(mockFetchCalls.length).toBe(1);
    expect(mockFetchCalls[0].url).toContain("/web/sessions/s1/user");
    expect(mockFetchCalls[0].method).toBe("GET");
  });

  // 测试列出文件带目录参数
  test("listFiles — with path query param", async () => {
    await client.web.sessions({ id: "s1" }).user.get({ path: "docs/" });
    expect(mockFetchCalls.length).toBe(1);
    expect(mockFetchCalls[0].url).toContain("/web/sessions/s1/user");
    // Eden Treaty passes query params via fetch options
    expect(mockFetchCalls[0].method).toBe("GET");
  });

  // 测试上传文件使用 fetchUpload 和 FormData
  test("fetchUpload — uses FormData and POST", async () => {
    const file = new File(["content"], "test.txt");
    const formData = new FormData();
    formData.append("files", file);
    await fetchUpload("/web/sessions/s1/user/docs/", formData);
    expect(mockFetchCalls.length).toBe(1);
    expect(mockFetchCalls[0].method).toBe("POST");
    expect(mockFetchCalls[0].body).toBeInstanceOf(FormData);
    expect(mockFetchCalls[0].url).toContain("/web/sessions/s1/user/");
  });
});
