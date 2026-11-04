import { describe, expect, test } from "bun:test";
import { testAcpConversation } from "../lib/external-api-v1/conversations";
import { ManualRunner, readChatStream } from "../lib/external-api-v1/runner";

describe("外部 API 手工测试执行器", () => {
  // 上一接口打印完响应并等到回车后，才允许发出下一请求。
  test("逐接口暂停，日志遮盖凭据且保留业务输入输出", async () => {
    const events: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        events.push("request");
        return Response.json({ success: true, data: { name: "created" } }, { status: 201 });
      },
    });
    let resume: (() => void) | undefined;
    let confirmPause: (() => void) | undefined;
    const paused = new Promise<void>((resolve) => {
      confirmPause = resolve;
    });
    const runner = new ManualRunner(
      { baseUrl: server.url.origin, apiKey: "private-key", timeoutMs: 1000 },
      {
        write: (line) => events.push(line),
        pause: () =>
          new Promise<void>((resolve) => {
            resume = resolve;
            events.push("pause");
            confirmPause?.();
          }),
      },
    );
    try {
      const running = runner.request("POST", "/api/v1/providers", {
        body: { name: "visible", apiKey: "upstream-key" },
        status: 201,
      });
      await paused;
      expect(events.at(-1)).toBe("pause");
      expect(events.filter((e) => e === "request")).toHaveLength(1);
      const logs = events.join("\n");
      expect(logs).toContain('响应体 {\n  "success": true,\n  "data": {\n    "name": "created"\n  }\n}');
      expect(logs).toContain("\u001b[32m结果 PASS\u001b[0m");
      expect(logs).toContain("visible");
      expect(logs).toContain("created");
      expect(logs).not.toContain("private-key");
      expect(logs).not.toContain("upstream-key");
      resume?.();
      await running;
    } finally {
      server.stop(true);
    }
  });

  // HTTP 200 但业务失败时也打印、暂停并终止，不能继续创建资源。
  test("业务失败不会计为成功，失败后仍暂停", async () => {
    const lines: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ success: false, error: { code: "DENIED", message: "拒绝" } }),
    });
    const runner = new ManualRunner(
      { baseUrl: server.url.origin, apiKey: "secret", timeoutMs: 1000 },
      {
        write: (line) => lines.push(line),
        pause: async () => {
          lines.push("paused");
        },
      },
    );
    try {
      await expect(runner.request("GET", "/api/v1/agents")).rejects.toThrow("DENIED");
      expect(lines.at(-1)).toBe("paused");
      expect(runner.operations.size).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  // SSE 任意网络分片与多字节文本仍能聚合，缺少终帧不能伪装完成。
  test("SSE 正确聚合中文分片并拒绝截断响应", async () => {
    const source =
      'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\r\n\r\n' +
      'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\r\n\r\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n' +
      "data: [DONE]\r\n\r\n";
    const bytes = new TextEncoder().encode(source);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    expect(await readChatStream(new Response(stream), () => {})).toBe("你好");
    await expect(
      readChatStream(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'), () => {}),
    ).rejects.toThrow();
  });

  // Relay 在聊天中断连时及时失败并保留暂停，不能等待到完整超时或继续下一轮。
  test("ACP 断连立即结束本轮并暂停", async () => {
    let pauses = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const rpc = JSON.parse(String(raw));
          if (rpc.method === "session/new")
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { sessionId: "ses_test" } }));
          else ws.close(1000);
        },
      },
    });
    const runner = new ManualRunner(
      { baseUrl: server.url.origin, apiKey: "key", timeoutMs: 5000 },
      {
        write: () => {},
        pause: async () => {
          pauses++;
        },
      },
    );
    try {
      await expect(testAcpConversation(runner, "/relay", "deny")).rejects.toThrow("已关闭");
      expect(pauses).toBe(3);
    } finally {
      server.stop(true);
    }
  }, 2000);
});
