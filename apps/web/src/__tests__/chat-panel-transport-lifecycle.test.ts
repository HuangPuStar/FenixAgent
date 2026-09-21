import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 建连 effect 与 session/load 的元数据刷新在同一个模块里（CE 阶段 2 §1.6 T6d 起 ChatPanel 的
// runtime 被拆到 `use-chat-panel-runtime.ts`），因此被钉住的两处锚点改在该文件中定位。
const RUNTIME_PATH = resolve(import.meta.dir, "../pages/agent-panel/use-chat-panel-runtime.ts");

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
});
