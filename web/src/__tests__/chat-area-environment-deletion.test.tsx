import { describe, expect, test } from "bun:test";
import { evictDeletedEnvironmentSlots, resolveActiveChatEnvironmentId } from "../pages/agent-panel/ChatArea";

describe("ChatArea 删除 Environment 生命周期", () => {
  // 删除当前 Environment 后必须禁用详情请求与当前槽位回填，避免持续请求已删除资源。
  test("已删除 Environment 不再作为活跃聊天目标", () => {
    expect(resolveActiveChatEnvironmentId("env-deleted", new Set(["env-deleted"]))).toBeNull();
    expect(resolveActiveChatEnvironmentId("env-active", new Set(["env-deleted"]))).toBe("env-active");
  });

  // 删除 Agent 时只驱逐其 Environment 会话，其他 Agent 的 keep-alive 会话必须保留。
  test("驱逐已删除 Environment 的全部 keep-alive 会话", () => {
    const slots = {
      "session-deleted-1": { agentId: "env-deleted", sessionId: "session-deleted-1" },
      "session-deleted-2": { agentId: "env-deleted", sessionId: "session-deleted-2" },
      "session-retained": { agentId: "env-retained", sessionId: "session-retained" },
    };

    expect(evictDeletedEnvironmentSlots(slots, new Set(["env-deleted"]))).toEqual({
      "session-retained": { agentId: "env-retained", sessionId: "session-retained" },
    });
  });

  // 没有命中删除集合时应复用原对象，避免无意义地重建所有 keep-alive 面板。
  test("未命中删除集合时保持缓存引用", () => {
    const slots = {
      "session-active": { agentId: "env-active", sessionId: "session-active" },
    };

    expect(evictDeletedEnvironmentSlots(slots, new Set(["env-other"]))).toBe(slots);
  });
});
