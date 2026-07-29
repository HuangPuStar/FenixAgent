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
 */
export function createDeterministicRcsSessionId(agentId: string, userId: string): string {
  return `rcs_${base64urlEncode(agentId)}.${base64urlEncode(userId)}`;
}
