import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { fileApi } from "../api/files";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Mock fetch globally
let mockFetchCalls: Array<{ url: string; method: string; headers?: Record<string, string>; body?: any }> = [];

const originalFetch = globalThis.fetch;

describe("File API Functions (new api/files)", () => {
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

  // 测试列出文件不带目录参数（新 API：id 为 string 而非 { id } 对象）
  test("listFiles — no path param", async () => {
    await fileApi.listDir("s1");
    expect(mockFetchCalls.length).toBe(1);
    expect(mockFetchCalls[0].url).toContain("/web/environments/s1/user");
    expect(mockFetchCalls[0].method).toBe("GET");
  });

  // 测试列出文件带目录参数（新 API：subpath 为 string 而非 { path } 对象）
  test("listFiles — with path query param", async () => {
    await fileApi.listDir("s1", "docs/");
    expect(mockFetchCalls.length).toBe(1);
    expect(mockFetchCalls[0].url).toContain("/web/environments/s1/user");
    expect(mockFetchCalls[0].url).toContain("path=docs");
    expect(mockFetchCalls[0].method).toBe("GET");
  });

  // 测试上传文件（新 API：upload(id, fd)，不再携带 path 拼接 URL）
  test("upload — uses FormData and POST", async () => {
    const file = new File(["content"], "test.txt");
    const formData = new FormData();
    formData.append("files", file);
    // 新 API 签名：upload(id: string, fd: FormData)，path 信息由 FormData 内部携带
    await fileApi.upload("s1", formData);
    expect(mockFetchCalls.length).toBe(1);
    expect(mockFetchCalls[0].method).toBe("POST");
    expect(mockFetchCalls[0].body).toBeInstanceOf(FormData);
    // 新 API 中 upload URL 不再拼接 path 到路径末尾
    expect(mockFetchCalls[0].url).toContain("/web/environments/s1/user");
  });
});
