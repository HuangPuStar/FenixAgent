import { afterEach, describe, expect, test } from "bun:test";
import { config, setConfig } from "../config";
import { createSandboxServerAdminService } from "../services/sandbox/sandbox-server-admin-service";

describe("sandbox server admin service", () => {
  const originalUrl = config.openSandboxClusterUrl;
  const originalKey = config.openSandboxClusterApiKey;

  afterEach(() => setConfig({ openSandboxClusterUrl: originalUrl, openSandboxClusterApiKey: originalKey }));

  // 远程列表查询必须把主服务参数转换为 OpenSandbox 的分页参数，并保留状态过滤。
  test("maps list query to the fixed Server proxy path", async () => {
    setConfig({ openSandboxClusterUrl: "http://cluster.internal", openSandboxClusterApiKey: "cluster-secret" });
    let receivedRequest: Request | undefined;
    const service = createSandboxServerAdminService(async (input, init) => {
      receivedRequest = new Request(String(input), init);
      return new Response(
        JSON.stringify({
          items: [],
          pagination: { page: 2, pageSize: 50, totalItems: 0, totalPages: 0, hasNextPage: false },
        }),
        {
          status: 200,
        },
      );
    });

    await service.listSandboxes("server/a", { state: "Running", page: 2, page_size: 50 });

    expect(receivedRequest?.url).toBe(
      "http://cluster.internal/api/v1/servers/server%2Fa/proxy/v1/sandboxes?state=Running&page=2&pageSize=50",
    );
    expect(receivedRequest?.headers.get("authorization")).toBe("Bearer cluster-secret");
  });

  // 诊断接口只能通过固定代理路径访问，不能让调用方注入任意远程路径。
  test("uses the fixed diagnostics path", async () => {
    setConfig({ openSandboxClusterUrl: "http://cluster.internal", openSandboxClusterApiKey: "cluster-secret" });
    const paths: string[] = [];
    const service = createSandboxServerAdminService(async (input) => {
      paths.push(String(input));
      if (String(input).endsWith("/diagnostics/summary")) return new Response("diagnostic text", { status: 200 });
      return new Response("unexpected path", { status: 404 });
    });

    await expect(service.getDiagnostics("server-a", "sandbox/a")).resolves.toBe("diagnostic text");
    expect(paths).toEqual([
      "http://cluster.internal/api/v1/servers/server-a/proxy/v1/sandboxes/sandbox%2Fa/diagnostics/summary",
    ]);
  });

  // 命令执行必须保留 Execd 的 SSE body 和 Content-Type，不在主服务中消费事件。
  test("returns the upstream command stream unchanged", async () => {
    setConfig({ openSandboxClusterUrl: "http://cluster.internal", openSandboxClusterApiKey: "cluster-secret" });
    let receivedRequest: Request | undefined;
    const service = createSandboxServerAdminService(async (input, init) => {
      receivedRequest = new Request(String(input), init);
      return new Response('data: {"type":"execution_complete"}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const response = await service.executeCommandStream("server-a", "sandbox-a", {
      command: "ls -al",
      background: false,
      timeout: 30_000,
    });

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toContain("execution_complete");
    const request = receivedRequest;
    if (!request) throw new Error("request was not captured");
    expect(JSON.stringify(await request.json())).toBe(
      JSON.stringify({ command: "ls -al", background: false, timeout: 30_000 }),
    );
  });
});
