import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 连接元数据与动作发送分属两个 hook，契约同时覆盖旧 socket 的注入与实际发送端口。
const RUNTIME_PATH = resolve(
  import.meta.dir,
  "../../../../packages/agent-runtime/web/agent-panel/use-chat-panel-runtime.ts",
);

const ACTIONS_PATH = resolve(
  import.meta.dir,
  "../../../../packages/agent-runtime/web/agent-panel/use-chat-panel-actions.ts",
);

describe("ChatPanel transport 生命周期", () => {
  // ACP 会话恢复只更新会话元数据，不得进入 YJS 建连 effect 的依赖并触发 Agent relay 重建。
  test("acpSessionId 更新不会成为连接重建条件", () => {
    const source = readFileSync(RUNTIME_PATH, "utf8");
    const effectStart = source.indexOf("// 创建 YjsWs 连接");
    const effectEnd = source.indexOf("// 从 chatState 提取 ACPMain 需要的派生状态", effectStart);
    const connectionEffect = source.slice(effectStart, effectEnd);

    expect(effectStart).toBeGreaterThanOrEqual(0);
    expect(effectEnd).toBeGreaterThan(effectStart);
    expect(connectionEffect).toContain("acpSessionId: acpSessionIdRef.current || undefined");
    expect(connectionEffect).not.toContain("sessionState.acpSessionId");
  });

  // 新协议 1008 回退后，用户动作仍走独立的旧 Yjs WS；发送链路不得依赖 syncChat。
  test("新协议回退不改变旧 WS 发送通道", () => {
    const runtimeSource = readFileSync(RUNTIME_PATH, "utf8");
    const source = readFileSync(ACTIONS_PATH, "utf8");
    const sendStart = source.indexOf("const sendViaWs");
    const sendEnd = source.indexOf("const sendAction", sendStart);
    const sendBlock = source.slice(sendStart, sendEnd);
    expect(sendStart).toBeGreaterThanOrEqual(0);
    expect(sendEnd).toBeGreaterThan(sendStart);
    expect(runtimeSource).toContain("} = useChatPanelActions({");
    expect(runtimeSource).toContain("wsRef: yjsWsRef");
    expect(runtimeSource).toContain("yjsWsRef.current = yjsWs");
    expect(sendBlock).toContain("wsRef.current.send(");
    expect(sendBlock).not.toContain("syncChat");
  });
});
