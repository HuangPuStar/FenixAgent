import { describe, expect, test } from "bun:test";
import { OpenSandboxClusterProvider } from "../opensandbox-cluster-provider";
import type { SandboxCreateInput } from "../types";

const input: SandboxCreateInput = {
  sandboxId: "sbi-flow-001",
  poolId: "pool-flow",
  template: { type: "image", value: "sandbox:latest" },
  resources: {
    cpu: 1,
    memoryMb: 512,
    diskGb: 5,
    gpuCount: 0,
    environment: {},
    volumes: [],
  },
};

describe("OpenSandbox Cluster Provider integration flow", () => {
  // Provider 的完整生命周期必须保持 allocate、create、get、resume、destroy、release 顺序。
  test("runs the lifecycle through one cluster binding", async () => {
    const calls: string[] = [];
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
        const path = new URL(String(url)).pathname;
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path.endsWith("/allocate")) {
          return Response.json({
            sandbox_id: "sbi-flow-001",
            pool_id: "pool-flow",
            server_id: "server-flow",
            proxy_url: "/api/v1/sandboxes/sbi-flow-001/proxy",
          });
        }
        if (path.endsWith("/resume")) {
          return Response.json({ id: "osb-flow-001", status: { state: "Running" } }, { status: 202 });
        }
        if (path.endsWith("/sandboxes") && init?.method === "POST") {
          return Response.json({ id: "osb-flow-001", status: { state: "Running" } }, { status: 202 });
        }
        if (path.endsWith("/osb-flow-001") && (!init?.method || init.method === "GET")) {
          return Response.json({ id: "osb-flow-001", status: { state: "Paused" } });
        }
        return new Response(null, { status: 204 });
      },
    );

    await expect(provider.create(input)).resolves.toMatchObject({ sandboxId: "osb-flow-001", status: "ready" });
    await expect(provider.get("osb-flow-001", "sbi-flow-001")).resolves.toMatchObject({ status: "stopped" });
    await expect(provider.resume("osb-flow-001", "sbi-flow-001")).resolves.toMatchObject({ status: "ready" });
    await expect(provider.destroy("osb-flow-001", "sbi-flow-001")).resolves.toBeUndefined();

    expect(calls).toEqual([
      "POST /api/v1/pools/pool-flow/sandboxes/sbi-flow-001/allocate",
      "POST /api/v1/sandboxes/sbi-flow-001/proxy/v1/sandboxes",
      "GET /api/v1/sandboxes/sbi-flow-001/proxy/v1/sandboxes/osb-flow-001",
      "POST /api/v1/sandboxes/sbi-flow-001/proxy/v1/sandboxes/osb-flow-001/resume",
      "DELETE /api/v1/sandboxes/sbi-flow-001/proxy/v1/sandboxes/osb-flow-001",
      "DELETE /api/v1/sandboxes/sbi-flow-001/allocation",
    ]);
  });

  // 创建请求超时不会在 Provider 内部自动发起第二次创建。
  test("does not retry create after a timeout", async () => {
    let createCalls = 0;
    const provider = new OpenSandboxClusterProvider(
      {
        baseUrl: "http://cluster.test",
        apiKey: "cluster-key",
        requestTimeoutMs: 1000,
        createTimeoutMs: 1,
        resumeTimeoutMs: 1000,
        destroyTimeoutMs: 1000,
      },
      async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/allocate")) {
          return Response.json({
            sandbox_id: "sbi-flow-001",
            pool_id: "pool-flow",
            server_id: "server-flow",
            proxy_url: "/api/v1/sandboxes/sbi-flow-001/proxy",
          });
        }
        createCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (init?.signal?.aborted) throw new DOMException("timeout", "TimeoutError");
        return Response.json({ id: "osb-flow-001", status: { state: "Running" } });
      },
    );

    await expect(provider.create(input)).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
    expect(createCalls).toBe(1);
  });
});
