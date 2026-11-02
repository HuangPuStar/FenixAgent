/**
 * IM 连接 token 的 HMAC 签发与校验（规格 §4.4 / §9.6）。
 *
 * token 唯一确定 conversation，是 MCP 连接的作用域：同一实例的会话、subagent 与后台任务共享它，工具参数
 * 因此不需要（也不允许）再带 `chat_id`。格式固定为 `im_<conversationId>.<signature>`，签名覆盖
 * conversationId，换一个 id 但保留签名即失败。
 *
 * 约束：
 * 1. 只做纯函数，不落库、不写日志、不进错误响应。
 * 2. 比较必须常数时间，避免按字节比较泄漏签名前缀。
 * 3. 密钥缺失时签发直接失败；校验返回 null（调用方返回 401），不降级成「无签名」。
 */

/** token 前缀；与 `im_channel_event` 等表名无关，只表达这是 IM 连接凭据。 */
const TOKEN_PREFIX = "im_";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 配置或输入问题；消息里不含任何密钥或 token 片段。 */
export class ImTokenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ImTokenError";
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(conversationId: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(conversationId));
  return encodeBase64Url(new Uint8Array(signature));
}

/** 常数时间比较：长度不同直接失败（长度不是秘密），逐字符 XOR 累积后统一判定。 */
function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

/** 签发连接 token；`secret` 由模块配置 `IM_TOKEN_SECRET` 提供。 */
export async function issueImToken(conversationId: string, secret: string | undefined): Promise<string> {
  if (!secret) throw new ImTokenError("IM_TOKEN_SECRET 未配置，无法签发连接 token");
  if (!UUID_PATTERN.test(conversationId)) throw new ImTokenError("conversationId 不是合法 UUID");
  const signature = await sign(conversationId, secret);
  return `${TOKEN_PREFIX}${conversationId}.${signature}`;
}

/**
 * 校验连接 token，返回它绑定的 conversationId；任何格式、签名或配置问题都返回 null。
 *
 * 不区分「格式错误」与「签名错误」：两者对调用方都是无效凭据，细分只会增加探测面。
 */
export async function verifyImToken(token: string, secret: string | undefined): Promise<string | null> {
  if (!secret || !token.startsWith(TOKEN_PREFIX)) return null;
  const remainder = token.slice(TOKEN_PREFIX.length);
  const separator = remainder.indexOf(".");
  // conversationId 是 UUID，本身不含点；多点或空段都是伪造形态。
  if (separator <= 0 || separator !== remainder.lastIndexOf(".")) return null;
  const conversationId = remainder.slice(0, separator);
  const signature = remainder.slice(separator + 1);
  if (!UUID_PATTERN.test(conversationId) || signature.length === 0) return null;

  const expected = await sign(conversationId, secret);
  return timingSafeEqual(signature, expected) ? conversationId : null;
}
