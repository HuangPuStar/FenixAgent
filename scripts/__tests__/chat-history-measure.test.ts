import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { measure } from "../chat-history/benchmark";
import { BenchmarkBrowser } from "../chat-history/browser";

type Fault = "none" | "late-browser" | "late-protocol" | "discovery" | "parsing" | "attachment" | "network" | "page";

/** 浏览器操作仅提供观测状态；CDP 建连、事件、错误解析和关闭均走真实 WebSocket。 */
function fixture(fault: Fault) {
  const sockets = new Set<ServerWebSocket<undefined>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/metrics") return Response.json({});
      if (server.upgrade(request, { data: undefined })) return;
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(socket: ServerWebSocket<undefined>) {
        sockets.add(socket);
      },
      close(socket: ServerWebSocket<undefined>) {
        sockets.delete(socket);
      },
      message(socket: ServerWebSocket<undefined>, data: string | Buffer) {
        const command = JSON.parse(String(data)) as { id: number; method: string };
        const rejected =
          (fault === "discovery" && command.method === "Target.getTargets") ||
          (fault === "attachment" && command.method === "Target.attachToTarget") ||
          (fault === "network" && command.method === "Network.enable") ||
          (fault === "page" && command.method === "Page.enable");
        let result: Record<string, unknown> = {};
        if (command.method === "Target.getTargets")
          result = { targetInfos: fault === "parsing" ? 42 : [{ type: "page", url: baseUrl, targetId: "target" }] };
        if (command.method === "Target.attachToTarget") result = { sessionId: "session" };
        if (command.method === "Page.addScriptToEvaluateOnNewDocument") result = { identifier: "script" };
        socket.send(JSON.stringify(rejected ? { id: command.id, error: { code: -1 } } : { id: command.id, result }));
      },
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const observation = {
    firstVisibleMs: 20,
    interactiveMs: 40,
    earlierMs: null as number | null,
    contentVerified: true,
    visibleCount: 100,
    projectedCount: 100,
    browserErrors: 0,
  };
  class Browser extends BenchmarkBrowser {
    override async run(args: readonly string[]): Promise<Record<string, unknown>> {
      return args[0] === "get" ? { cdpUrl: `ws://127.0.0.1:${server.port}/cdp` } : {};
    }
    override async evaluate(expression: string): Promise<unknown> {
      if (expression === "location.href") return `${baseUrl}/chat`;
      if (expression.includes("snapshot()")) return { ...observation };
      if (expression.includes("getBoundingClientRect"))
        return { viewportWidth: 1280, viewportHeight: 720, contentWidth: 800, contentDisplay: "flex" };
      if (expression.includes(".earlier()")) {
        observation.earlierMs = 80;
        if (fault === "late-browser") observation.browserErrors = 1;
        if (fault === "late-protocol") {
          for (const socket of sockets) {
            socket.send(
              JSON.stringify({
                sessionId: "session",
                method: "Network.webSocketCreated",
                params: { requestId: "chat", url: `${baseUrl}/acp/yjs/rcs?chatSync=1` },
              }),
            );
            socket.send(
              JSON.stringify({
                sessionId: "session",
                method: "Network.webSocketFrameReceived",
                params: { requestId: "chat", response: {} },
              }),
            );
          }
          await Bun.sleep(10);
        }
        return true;
      }
      throw new Error(`Unexpected benchmark observation: ${expression}`);
    }
  }
  return {
    sockets,
    async run() {
      return await measure(
        { version: "candidate", baseUrl, controlUrl: baseUrl, browser: new Browser("test-measure") },
        { entryCount: 1000, fixtureDigest: "fixture", url: `${baseUrl}/chat` },
        0,
        "reopen",
        "hot",
      );
    },
    close() {
      server.stop(true);
    },
  };
}

for (const fault of ["late-browser", "late-protocol"] as const) {
  // 首屏成功不能掩盖翻页后的浏览器或协议错误，哪怕翻页耗时已经采集成功。
  test(`${fault} 使完整加载样本失败`, async () => {
    const f = fixture(fault);
    try {
      const sample = await f.run();
      expect(sample.earlierMs).toBe(80);
      expect(sample.failure).toBe("browser-error");
      expect(sample.counters?.[fault === "late-browser" ? "browserErrors" : "protocolErrors"]).toBe(1);
    } finally {
      f.close();
    }
  });
}

// 正常完整加载仍须成功，错误检测不能把所有样本都判失败。
test("首屏与翻页均无错误时保留成功样本", async () => {
  const f = fixture("none");
  try {
    expect(await f.run()).toMatchObject({
      failure: null,
      contentVerified: true,
      earlierMs: 80,
      counters: { browserErrors: 0, protocolErrors: 0 },
    });
  } finally {
    f.close();
  }
});

for (const fault of ["discovery", "parsing", "attachment", "network", "page"] as const) {
  // 页面 attach 失败时调用方尚未取得 handle，建连函数必须关闭自己已取得的 CDP 资源。
  test(`${fault} 失败后关闭未交付的 CDP 连接`, async () => {
    const f = fixture(fault);
    try {
      expect((await f.run()).failure).toBe("measurement-error");
      for (let i = 0; i < 100 && f.sockets.size; i++) await Bun.sleep(10);
      expect(f.sockets.size).toBe(0);
    } finally {
      f.close();
    }
  });
}
