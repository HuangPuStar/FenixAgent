/**
 * claude-acp-adapter 的目标会话解析与 sessionId 唯一性测试（C-P1.2 机器端修复）。
 *
 * 并发 run 在共享连接上各自携带 sessionId（server.ts 已按 params.sessionId 路由），
 * adapter 的 prompt 必须解析到请求指定的会话而不是连接级共享的 activeSessionId。
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAcpConnection, resolvePromptTargetSession, type SessionState } from "../client/claude-acp-adapter";

function makeSessionState(sessionId: string): SessionState {
  return { sessionId, cwd: "/tmp", createdAt: 0, title: `Conversation ${sessionId}` };
}

describe("resolvePromptTargetSession", () => {
  // 并发 run 各自携带 sessionId，解析到对应 session
  test("prompt 携带 sessionId 时解析到对应 session", () => {
    const sessions = new Map<string, SessionState>([
      ["claude_1", makeSessionState("claude_1")],
      ["claude_2", makeSessionState("claude_2")],
    ]);
    const result = resolvePromptTargetSession({ sessionId: "claude_2" }, sessions, "claude_1");
    expect(result.targetSessionId).toBe("claude_2");
    expect(result.targetSession?.sessionId).toBe("claude_2");
  });

  // yjs 前端 translator 的 prompt 不带 sessionId，fallback 到连接级当前会话
  test("prompt 未携带 sessionId 时 fallback 到连接级 activeSessionId", () => {
    const sessions = new Map<string, SessionState>([["claude_cur", makeSessionState("claude_cur")]]);
    const result = resolvePromptTargetSession({}, sessions, "claude_cur");
    expect(result.targetSessionId).toBe("claude_cur");
    expect(result.targetSession?.sessionId).toBe("claude_cur");
  });

  // 请求的 sessionId 在 Map 中不存在（如已被清理）时保守 fallback 到连接级会话
  test("prompt 携带未知 sessionId 时 fallback 到 activeSessionId", () => {
    const sessions = new Map<string, SessionState>();
    const result = resolvePromptTargetSession({ sessionId: "claude_unknown" }, sessions, "claude_cur");
    expect(result.targetSessionId).toBe("claude_cur");
    expect(result.targetSession).toBeUndefined();
  });
});

describe("newSession sessionId 唯一性", () => {
  // 修复前 sessionId 为 claude_${Date.now()}：同毫秒并发 newSession 返回相同 id，
  // 两个 run 会拿到同一会话；自增后缀保证进程内唯一
  test("并发两个连接的 newSession 返回的 sessionId 互不相同", async () => {
    const dir = await mkdtemp(join(tmpdir(), "acp-link-session-id-"));
    try {
      const send = () => {};
      const conn1 = createClaudeAcpConnection(dir, "inst-1", send, "system", "model");
      const conn2 = createClaudeAcpConnection(dir, "inst-2", send, "system", "model");
      const [r1, r2] = await Promise.all([conn1.newSession({}), conn2.newSession({})]);
      expect(r1.sessionId).toBeDefined();
      expect(r2.sessionId).toBeDefined();
      expect(r1.sessionId).not.toBe(r2.sessionId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
