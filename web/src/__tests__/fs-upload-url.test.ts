import { beforeEach, describe, expect, mock, test } from "bun:test";

import { buildUploadUrl } from "../api/fs";

const fetchMock = {
  lastUrl: "",
  method: "",
  body: null as BodyInit | null | undefined,
};

beforeEach(() => {
  fetchMock.lastUrl = "";
  fetchMock.method = "";
  fetchMock.body = null;
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetchMock.lastUrl = String(input);
    fetchMock.method = init?.method ?? "GET";
    fetchMock.body = init?.body ?? null;
    return new Response(JSON.stringify({ success: true, data: { files: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

describe("buildUploadUrl", () => {
  // 回归：未选中目录（targetDir 为空）上传到 workspace 根，URL 必须以 /fs/ 结尾，
  // 否则 Elysia splat 路由不匹配空段，后端返回 404
  test("empty targetDir keeps trailing slash (/fs/)", () => {
    expect(buildUploadUrl("env_1")).toBe("/web/environments/env_1/fs/");
    expect(buildUploadUrl("env_1", "")).toBe("/web/environments/env_1/fs/");
  });

  // 指定子目录时拼接目录路径，保持上传到非根目录的既有行为
  test("non-empty targetDir is appended after /fs/", () => {
    expect(buildUploadUrl("env_1", "docs")).toBe("/web/environments/env_1/fs/docs");
  });

  // 带前导斜杠的 targetDir（如 "/docs"）需去除前导斜杠，避免拼出双斜杠
  test("leading slashes of targetDir are stripped", () => {
    expect(buildUploadUrl("env_1", "/docs/notes")).toBe("/web/environments/env_1/fs/docs/notes");
  });

  // 环境 ID 需 URL 编码，与 request() 路径参数替换行为保持一致
  test("environment id is URL-encoded", () => {
    expect(buildUploadUrl("a b")).toBe("/web/environments/a%20b/fs/");
  });
});

describe("fsApi.upload", () => {
  // 回归：无 targetDir 时实际发出的请求 URL 以 /fs/ 结尾（修复根上传 404 的端到端断言）
  test("upload without targetDir sends POST to /fs/", async () => {
    const { fsApi } = await import("../api/fs");
    const fd = new FormData();
    fd.append("files", new File(["content"], "a.txt"));
    await fsApi.upload("env_1", fd);
    expect(fetchMock.lastUrl).toBe("/web/environments/env_1/fs/");
    expect(fetchMock.method).toBe("POST");
    expect(fetchMock.body).toBeInstanceOf(FormData);
  });

  // 指定目录时上传请求指向对应子目录，URL 行为与根上传一致收敛于 buildUploadUrl
  test("upload with targetDir sends POST to /fs/<dir>", async () => {
    const { fsApi } = await import("../api/fs");
    const fd = new FormData();
    fd.append("files", new File(["content"], "a.txt"));
    await fsApi.upload("env_1", fd, "docs");
    expect(fetchMock.lastUrl).toBe("/web/environments/env_1/fs/docs");
    expect(fetchMock.method).toBe("POST");
  });
});
