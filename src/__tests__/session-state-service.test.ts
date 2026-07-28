import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { clearSessionYDocContent } from "../services/session-state-service";

describe("clearSessionYDocContent", () => {
  // 清空规则必须同时覆盖旧消息、结构化消息、流式状态、工具、产物及元数据状态。
  test("clears all session content while restoring idle metadata", () => {
    const ydoc = new Y.Doc();
    ydoc.getArray("messages").push(["message"]);
    ydoc.getArray("structuredMessages").push(["structured-message"]);
    ydoc.getMap("streaming").set("text", "streaming");
    ydoc.getMap("tools").set("tool-1", "running");
    ydoc.getArray("artifacts").push(["artifact"]);
    const meta = ydoc.getMap("meta");
    meta.set("status", "responding");
    meta.set("loading", { requestId: "request-1" });

    clearSessionYDocContent(ydoc);

    expect(ydoc.getArray("messages").length).toBe(0);
    expect(ydoc.getArray("structuredMessages").length).toBe(0);
    expect(ydoc.getMap("streaming").size).toBe(0);
    expect(ydoc.getMap("tools").size).toBe(0);
    expect(ydoc.getArray("artifacts").length).toBe(0);
    expect(meta.get("status")).toBe("idle");
    expect(meta.get("loading")).toBeNull();
  });
});
