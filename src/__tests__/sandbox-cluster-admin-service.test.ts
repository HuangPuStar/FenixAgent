import { afterEach, describe, expect, test } from "bun:test";
import { config, setConfig } from "../config";
import {
  createSandboxClusterAdminService,
  SandboxClusterUnavailableError,
} from "../services/sandbox/sandbox-cluster-admin-service";

describe("sandbox cluster admin service", () => {
  const originalUrl = config.openSandboxClusterUrl;
  const originalKey = config.openSandboxClusterApiKey;

  afterEach(() => setConfig({ openSandboxClusterUrl: originalUrl, openSandboxClusterApiKey: originalKey }));

  // Cluster 代理必须在服务端附加 Cluster 凭据，浏览器请求不能直接接触该凭据。
  test("forwards the server-side cluster credential", async () => {
    setConfig({ openSandboxClusterUrl: "http://cluster.internal", openSandboxClusterApiKey: "cluster-secret" });
    let receivedRequest: Request | undefined;
    const service = createSandboxClusterAdminService(async (input, init) => {
      receivedRequest = new Request(String(input), init);
      return new Response(JSON.stringify([{ id: "pool-1" }]), { status: 200 });
    });

    await expect(service.listPools()).resolves.toEqual([{ id: "pool-1" }]);
    expect(receivedRequest?.url).toBe("http://cluster.internal/api/v1/pools");
    expect(receivedRequest?.headers.get("authorization")).toBe("Bearer cluster-secret");
  });

  // 未配置 Cluster 连接时必须快速失败，不允许退化为未认证请求。
  test("fails closed when cluster credentials are missing", async () => {
    setConfig({ openSandboxClusterUrl: undefined, openSandboxClusterApiKey: undefined });
    const service = createSandboxClusterAdminService(async () => new Response("unexpected", { status: 200 }));

    await expect(service.listPools()).rejects.toBeInstanceOf(SandboxClusterUnavailableError);
  });

  // Cluster 返回业务错误时必须保留原始 message，便于管理端定位删除失败原因。
  test("preserves the cluster error message", async () => {
    setConfig({ openSandboxClusterUrl: "http://cluster.internal", openSandboxClusterApiKey: "cluster-secret" });
    const service = createSandboxClusterAdminService(
      async () =>
        new Response(JSON.stringify({ error: { code: "CONFLICT", message: "pool has active sandbox bindings" } }), {
          status: 409,
        }),
    );

    await expect(service.deletePool("pool-1")).rejects.toMatchObject({
      status: 409,
      message: "pool has active sandbox bindings",
    });
  });
});
