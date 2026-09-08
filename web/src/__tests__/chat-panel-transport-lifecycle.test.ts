import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CHAT_PANEL_PATH = resolve(import.meta.dir, "../pages/agent-panel/ChatPanel.tsx");

describe("ChatPanel transport 生命周期", () => {
  // ACP 会话恢复只更新会话元数据，不得进入 YJS 建连 effect 的依赖并触发 Agent relay 重建。
  test("acpSessionId 更新不会成为连接重建条件", () => {
    const source = readFileSync(CHAT_PANEL_PATH, "utf8");
    const effectStart = source.indexOf("// 创建 YjsWs 连接");
    const effectEnd = source.indexOf("// 从 chatState 提取 ACPMain 需要的派生状态", effectStart);
    const connectionEffect = source.slice(effectStart, effectEnd);

    expect(effectStart).toBeGreaterThanOrEqual(0);
    expect(effectEnd).toBeGreaterThan(effectStart);
    expect(connectionEffect).toContain("acpSessionId: acpSessionIdRef.current || undefined");
    expect(connectionEffect).not.toContain("sessionState.acpSessionId");
  });
});
