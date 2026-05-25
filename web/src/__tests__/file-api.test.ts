import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { fileApi } from "../api/sdk";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Mock fetch globally
let mockFetchCalls: Array<{ url: string; method: string; headers?: Record<string, string>; body?: any }> = [];

const originalFetch = globalThis.fetch;

describe("File API Functions (SDK)", () => {
  beforeEach(() => {
    mockFetchCalls = [];
    globalThis.fetch = Object.assign(
      async (input: any, init?: any) => {
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
      },
      { preconnect: () => {} },
    ) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  // 测试列出文件不带目录参数
  test("listFiles — no path param", async () => {
    await fileApi.listDir({ id: "s1" });
    expect(mockFetchCalls.length).toBe(1);
    expect(mockFetchCalls[0].url).toContain("/web/environments/s1/user");
    expect(mockFetchCalls[0].method).toBe("GET");
  });

  // 测试列出文件带目录参数
  test("listFiles — with path query param", async () => {
    await fileApi.listDir({ id: "s1" }, { path: "docs/" });
    expect(mockFetchCalls.length).toBe(1);
    expect(mockFetchCalls[0].url).toContain("/web/environments/s1/user");
    expect(mockFetchCalls[0].url).toContain("path=docs");
    expect(mockFetchCalls[0].method).toBe("GET");
  });

  // 测试上传文件使用 SDK upload 和 FormData
  test("upload — uses FormData and POST", async () => {
    const file = new File(["content"], "test.txt");
    const formData = new FormData();
    formData.append("files", file);
    await fileApi.upload({ id: "s1", path: "docs" }, formData);
    expect(mockFetchCalls.length).toBe(1);
    expect(mockFetchCalls[0].method).toBe("POST");
    expect(mockFetchCalls[0].body).toBeInstanceOf(FormData);
    expect(mockFetchCalls[0].url).toContain("/web/environments/s1/user/docs");
  });
});
