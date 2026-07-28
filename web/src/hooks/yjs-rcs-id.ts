// web/src/hooks/yjs-rcs-id.ts
// 前端版 createDeterministicRcsSessionId，与服务端 ws-lifecycle.ts 保持完全一致。

/** UTF-8 字符串 → base64url（浏览器兼容版，等价于 Node.js Buffer.from(str,"utf8").toString("base64url")） */
function base64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 生成服务端控制的 RCS 会话标识。
 * 与服务端 ws-lifecycle.ts 的 createDeterministicRcsSessionId 完全一致。
 */
export function createDeterministicRcsSessionId(agentId: string, userId: string): string {
  return `rcs_${base64urlEncode(agentId)}.${base64urlEncode(userId)}`;
}
