/**
 * 远端进程死亡回归测试用的最小 ACP Agent fixture（NDJSON over stdio）。
 * prompt 永不响应，用于模拟「执行中死亡」；关闭 stdout 的场景由用例在父进程侧模拟 EOF。
 */
import { createInterface } from "node:readline";

const write = (message) => {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  } catch {
    // stdout 已关闭（EOF 场景）：进程仍需存活以验证父进程的失联收口。
  }
};
const pendingPrompts = new Map();

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        agentInfo: { name: "remote-death-fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "session/new") {
    write({ jsonrpc: "2.0", id, result: { sessionId: "ses_fixture" } });
    return;
  }
  if (method === "session/prompt") {
    pendingPrompts.set(id, params?.sessionId ?? "ses_fixture");
    return;
  }
  if (method === "session/cancel") {
    for (const pendingId of pendingPrompts.keys()) {
      write({ jsonrpc: "2.0", id: pendingId, result: { stopReason: "cancelled" } });
    }
    pendingPrompts.clear();
    return;
  }
  if (id !== undefined) {
    write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
