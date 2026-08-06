import { describe, expect, test } from "bun:test";
import { ClusterHttpClient } from "../http-client";
import { SandboxProviderError } from "../provider";

describe("ClusterHttpClient", () => {
  // Cluster 管理请求必须使用 Bearer 鉴权并正确解析 JSON 响应。
  test("sends bearer authentication and decodes JSON", async () => {
    const client = new ClusterHttpClient(async (url, init) => {
      expect(String(url)).toBe("http://cluster.test/api/v1/pools/pool-1/sandboxes/sbi-1/allocate");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer cluster-key");
      return Response.json({ server_id: "server-1" });
    });

    await expect(
      client.json("http://cluster.test", "cluster-key", "/api/v1/pools/pool-1/sandboxes/sbi-1/allocate", 1000),
    ).resolves.toEqual({ server_id: "server-1" });
  });

  // 远程 404 必须保留状态码，Provider 才能单独处理资源不存在。
  test("preserves HTTP status and retryability", async () => {
    const client = new ClusterHttpClient(async () => new Response("missing", { status: 404 }));

    await expect(client.json("http://cluster.test", "cluster-key", "/missing", 1000)).rejects.toMatchObject({
      code: "NOT_FOUND",
      retryable: false,
      status: 404,
    } satisfies Partial<SandboxProviderError>);
  });

  // 5xx 错误应标记为可重试，而不是转换成资源不存在。
  test("marks server errors as retryable", async () => {
    const client = new ClusterHttpClient(async () => new Response("down", { status: 503 }));

    await expect(client.json("http://cluster.test", "cluster-key", "/health", 1000)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
      status: 503,
    } satisfies Partial<SandboxProviderError>);
  });
});
