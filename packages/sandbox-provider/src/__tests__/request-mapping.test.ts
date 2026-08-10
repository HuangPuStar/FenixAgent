import { describe, expect, test } from "bun:test";
import { OpenSandboxClusterProvider } from "../opensandbox-cluster-provider";
import type { SandboxCreateInput } from "../types";

function providerWithBody(body: { body?: string }): OpenSandboxClusterProvider {
  return new OpenSandboxClusterProvider(
    {
      baseUrl: "http://cluster.test",
      apiKey: "cluster-key",
      requestTimeoutMs: 1000,
      createTimeoutMs: 1000,
      resumeTimeoutMs: 1000,
      destroyTimeoutMs: 1000,
    },
    async (url, init) => {
      if (String(url).endsWith("/allocate")) {
        return Response.json({
          sandbox_id: "sbi-test-001",
          pool_id: "pool-test",
          server_id: "server-test",
          proxy_url: "/api/v1/sandboxes/sbi-test-001/proxy",
        });
      }
      body.body = String(init?.body);
      return Response.json({ id: "osb-001", status: { state: "Running" } }, { status: 202 });
    },
  );
}

const baseInput: SandboxCreateInput = {
  sandboxId: "sbi-test-001",
  poolId: "pool-test",
  template: { type: "image", value: "sandbox:latest" },
  resources: {
    cpu: 1,
    memoryMb: 512,
    diskGb: 5,
    gpuCount: 0,
    environment: { LANG: "C.UTF-8" },
    volumes: [],
  },
};

describe("OpenSandbox Cluster request mapping", () => {
  // Provider 只传递相对 host path，不能把宿主机 workspace 绝对路径带入 Fenix。
  test("maps image resources environment and relative host volumes", async () => {
    const captured: { body?: string } = {};
    const provider = providerWithBody(captured);
    await provider.create({
      ...baseInput,
      resources: {
        ...baseInput.resources,
        cpu: 2,
        memoryMb: 2048,
        diskGb: 20,
        environment: { LANG: "C.UTF-8", RCS_MACHINE_ID: "mach-test-001" },
        volumes: [{ name: "workspace", source: "./ws", target: "/workspace", readOnly: true }],
      },
    });

    expect(JSON.parse(captured.body ?? "{}")).toEqual({
      image: { uri: "sandbox:latest" },
      timeout: null,
      resourceLimits: { cpu: "2000m", memory: "2048Mi", disk: "20Gi", gpu: "0" },
      env: { LANG: "C.UTF-8", RCS_MACHINE_ID: "mach-test-001" },
      volumes: [{ name: "workspace", host: { path: "./ws" }, mountPath: "/workspace", readOnly: true }],
    });
  });

  // OpenSandbox Server 要求 image 请求显式带 entrypoint，Provider 应传递资源池中的 Provider 配置。
  test("maps OpenSandbox entrypoint from provider extra", async () => {
    const captured: { body?: string } = {};
    const provider = providerWithBody(captured);
    await provider.create({
      ...baseInput,
      providerExtra: {
        entrypoint: ["docker-entrypoint.sh", "acp-runtime", "opencode", "acp"],
      },
    });

    expect(JSON.parse(captured.body ?? "{}").entrypoint).toEqual([
      "docker-entrypoint.sh",
      "acp-runtime",
      "opencode",
      "acp",
    ]);
  });

  // 没有 source 的内部 volume 模型无法安全映射为 OpenSandbox host volume，应在远程调用前拒绝。
  test("rejects a volume without a source path", async () => {
    const provider = providerWithBody({});
    await expect(
      provider.create({
        ...baseInput,
        resources: {
          ...baseInput.resources,
          volumes: [{ name: "workspace", target: "/workspace" }],
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
