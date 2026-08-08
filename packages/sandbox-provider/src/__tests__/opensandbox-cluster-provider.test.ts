import { describe, expect, test } from "bun:test";
import { OpenSandboxClusterProvider } from "../opensandbox-cluster-provider";
import type { SandboxCreateInput } from "../types";

const input: SandboxCreateInput = {
  sandboxId: "sbi-test-001",
  poolId: "pool-test",
  template: { type: "image", value: "ghcr.io/example/agent:latest" },
  resources: {
    cpu: 2,
    memoryMb: 2048,
    diskGb: 20,
    gpuCount: 0,
    environment: { LANG: "C.UTF-8" },
    volumes: [{ name: "workspace", source: "user-123/ws", target: "/workspace" }],
  },
};

describe("OpenSandboxClusterProvider contract", () => {
  // 创建输入使用 Fenix 业务沙盒 ID，Provider 返回值保存 OpenSandbox 外部 ID。
  test("keeps business sandbox id separate from provider sandbox id", () => {
    expect(input.sandboxId).toBe("sbi-test-001");
    expect(input.template.type).toBe("image");
  });

  // 创建必须先幂等分配 Cluster binding，再调用目标 Server 的原生创建接口。
  test("allocates and creates a sandbox through the cluster proxy", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new OpenSandboxClusterProvider(
      {
        baseUrl: "http://cluster.test",
        apiKey: "cluster-key",
        requestTimeoutMs: 1000,
        createTimeoutMs: 1000,
        resumeTimeoutMs: 1000,
        destroyTimeoutMs: 1000,
      },
      async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith("/allocate")) {
          return Response.json({
            sandbox_id: "sbi-test-001",
            pool_id: "pool-test",
            server_id: "server-test",
            proxy_url: "/api/v1/sandboxes/sbi-test-001/proxy",
          });
        }
        return Response.json({ id: "osb-001", status: { state: "Running" } }, { status: 202 });
      },
    );

    await expect(provider.create(input)).resolves.toMatchObject({
      sandboxId: "osb-001",
      status: "ready",
    });
    expect(requests.map((request) => request.url)).toEqual([
      "http://cluster.test/api/v1/pools/pool-test/sandboxes/sbi-test-001/allocate",
      "http://cluster.test/api/v1/sandboxes/sbi-test-001/proxy/v1/sandboxes",
    ]);
    const createBody = JSON.parse(String(requests[1]?.init?.body));
    expect(createBody).toMatchObject({
      image: { uri: "ghcr.io/example/agent:latest" },
      timeout: null,
      resourceLimits: { cpu: "2000m", memory: "2048Mi", gpu: "0" },
      env: { LANG: "C.UTF-8" },
    });
    expect(createBody.volumes).toEqual([{ name: "workspace", host: { path: "user-123/ws" }, mountPath: "/workspace" }]);
  });

  // 生命周期请求必须使用业务 ID 定位 Cluster，再使用外部 ID定位 OpenSandbox。
  test("gets and resumes the existing provider sandbox", async () => {
    const paths: string[] = [];
    const provider = new OpenSandboxClusterProvider(
      {
        baseUrl: "http://cluster.test",
        apiKey: "cluster-key",
        requestTimeoutMs: 1000,
        createTimeoutMs: 1000,
        resumeTimeoutMs: 1000,
        destroyTimeoutMs: 1000,
      },
      async (url, init) => {
        paths.push(`${init?.method ?? "GET"} ${String(url)}`);
        return String(url).endsWith("/resume")
          ? Response.json({ id: "osb-001", status: { state: "Running" } }, { status: 202 })
          : Response.json({ id: "osb-001", status: { state: "Paused" } });
      },
    );

    await expect(provider.get("osb-001", "sbi-test-001")).resolves.toMatchObject({ status: "stopped" });
    await expect(provider.resume("osb-001", "sbi-test-001")).resolves.toMatchObject({ status: "ready" });
    expect(paths).toEqual([
      "GET http://cluster.test/api/v1/sandboxes/sbi-test-001/proxy/v1/sandboxes/osb-001",
      "POST http://cluster.test/api/v1/sandboxes/sbi-test-001/proxy/v1/sandboxes/osb-001/resume",
    ]);
  });

  // 远程删除成功后才释放 binding，删除失败时不能提前丢失定位关系。
  test("releases allocation after destroy", async () => {
    const paths: string[] = [];
    const provider = new OpenSandboxClusterProvider(
      {
        baseUrl: "http://cluster.test",
        apiKey: "cluster-key",
        requestTimeoutMs: 1000,
        createTimeoutMs: 1000,
        resumeTimeoutMs: 1000,
        destroyTimeoutMs: 1000,
      },
      async (url, init) => {
        paths.push(`${init?.method ?? "GET"} ${String(url)}`);
        return new Response(null, { status: 204 });
      },
    );

    await provider.destroy("osb-001", "sbi-test-001");
    expect(paths).toEqual([
      "DELETE http://cluster.test/api/v1/sandboxes/sbi-test-001/proxy/v1/sandboxes/osb-001",
      "DELETE http://cluster.test/api/v1/sandboxes/sbi-test-001/allocation",
    ]);
  });

  // OpenSandbox 已经返回 404 时按已删除处理，但仍需释放 Cluster binding。
  test("releases allocation when the provider sandbox is already gone", async () => {
    const paths: string[] = [];
    const provider = new OpenSandboxClusterProvider(
      {
        baseUrl: "http://cluster.test",
        apiKey: "cluster-key",
        requestTimeoutMs: 1000,
        createTimeoutMs: 1000,
        resumeTimeoutMs: 1000,
        destroyTimeoutMs: 1000,
      },
      async (url, init) => {
        paths.push(`${init?.method ?? "GET"} ${String(url)}`);
        return String(url).endsWith("/allocation")
          ? new Response(null, { status: 204 })
          : new Response("not found", { status: 404 });
      },
    );

    await provider.destroy("osb-001", "sbi-test-001");
    expect(paths.at(-1)).toBe("DELETE http://cluster.test/api/v1/sandboxes/sbi-test-001/allocation");
  });

  // 远程删除失败时必须保留 binding，确保后续仍可按业务 ID定位资源。
  test("does not release allocation when remote destroy fails", async () => {
    const paths: string[] = [];
    const provider = new OpenSandboxClusterProvider(
      {
        baseUrl: "http://cluster.test",
        apiKey: "cluster-key",
        requestTimeoutMs: 1000,
        createTimeoutMs: 1000,
        resumeTimeoutMs: 1000,
        destroyTimeoutMs: 1000,
      },
      async (url, init) => {
        paths.push(`${init?.method ?? "GET"} ${String(url)}`);
        return new Response("server down", { status: 503 });
      },
    );

    await expect(provider.destroy("osb-001", "sbi-test-001")).rejects.toMatchObject({
      code: "UNAVAILABLE",
      retryable: true,
    });
    expect(paths).toHaveLength(1);
  });
});
