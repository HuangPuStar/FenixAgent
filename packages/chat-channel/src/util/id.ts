// packages/acp-server/src/util/id.ts
// 确定性 RCS 会话标识生成 — 前后端共用的唯一实现。

function base64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 生成服务端控制的 RCS 会话标识。
 *
 * 环境和用户 ID 都是无格式约束的字符串；分别使用完整 UTF-8 的 base64url 编码，
 * 再以不属于 base64url 字母表的 `.` 分隔，使结果可逆且不引入截断或哈希碰撞风险。
 *
 * 当提供 `sessionId` 时（多实例场景），将其纳入标识，确保同一 agent 不同实例/会话
 * 拥有独立的 YJS doc，避免多实例共用同一文档导致的数据串扰。
 * 格式规则：`.` 分隔数量区分版本 —— 1 个点 = (agentId, userId)，2 个点 = (agentId, userId, sessionId)。
 */
export function createDeterministicRcsSessionId(agentId: string, userId: string, sessionId?: string): string {
  const parts = [base64urlEncode(agentId), base64urlEncode(userId)];
  if (sessionId) {
    parts.push(base64urlEncode(sessionId));
  }
  return `rcs_${parts.join(".")}`;
}
