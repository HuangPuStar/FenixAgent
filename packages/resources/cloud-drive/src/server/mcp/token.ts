/**
 * CloudDrive MCP 连接 token 的 HMAC 签发与校验。
 *
 * 为什么需要它：Agent 进程只能拿到「属于当前用户、只覆盖云盘」的凭据，不能拿到 CloudDrive master
 * key（后者能冒充任意 subject）。token 因此由 Fenix 服务端签发，网关只从 token 派生主体，工具参数里
 * 不出现任何用户标识。
 *
 * 格式固定为 `cd1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, "cd1.<payload>"))>`：
 *
 * 1. 版本前缀进入签名范围，换版本必须重新签名，不会被降级解析。
 * 2. payload 是 JSON，显式携带 `exp` 与 `scope`；网关不信任任何请求参数。
 * 3. 校验必须常数时间比较，避免按字节比较泄漏签名前缀。
 * 4. 密钥缺失时签发失败、校验返回 null（调用方给 401/503），绝不降级成「无签名」。
 * 5. 纯函数、不落库、不写日志、不进错误响应。
 */

/** 作用域由部署配置决定：`read` 只读；`write` 才注册写工具。 */
export type CloudDriveMcpScope = "read" | "write";

/** 网关从 token 派生出的主体；工具处理器只能用它构造 Facade actor。 */
export interface CloudDriveMcpTokenClaims {
  readonly userId: string;
  readonly organizationId: string;
  readonly scope: CloudDriveMcpScope;
  /** 过期时间（epoch 秒）。 */
  readonly expiresAt: number;
}

export interface IssueCloudDriveMcpTokenInput {
  readonly userId: string;
  readonly organizationId: string;
  readonly scope: CloudDriveMcpScope;
  readonly ttlSeconds: number;
  /** `CLOUDDRIVE_MCP_TOKEN_SECRET`；缺失时签发失败。 */
  readonly secret: string | undefined;
  /** 测试注入的当前时间（epoch 秒）。 */
  readonly nowSeconds?: number;
}

/** token 前缀；签名范围包含它，因此换前缀不能复用旧签名。 */
const TOKEN_PREFIX = "cd1";
/** 生产 token 只允许这两个值；未知 scope 一律无效，避免未来新增 scope 被旧网关误读。 */
const SCOPES: readonly CloudDriveMcpScope[] = ["read", "write"];
/** 用户/组织标识的允许字符集：与 CloudDrive subject 规则一致，且不含分隔符。 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/** 配置或输入问题；消息里不含任何密钥或 token 片段。 */
export class CloudDriveMcpTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudDriveMcpTokenError";
  }
}

function currentSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

async function sign(signingInput: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
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

/**
 * 签发连接 token。
 *
 * 主体只允许来自已认证的 environment / 会话上下文；调用方不得把请求参数透传进来。
 */
export async function issueCloudDriveMcpToken(input: IssueCloudDriveMcpTokenInput): Promise<string> {
  const secret = input.secret?.trim();
  if (!secret) throw new CloudDriveMcpTokenError("CLOUDDRIVE_MCP_TOKEN_SECRET 未配置，无法签发 CloudDrive MCP token");
  if (!IDENTIFIER_PATTERN.test(input.userId)) throw new CloudDriveMcpTokenError("userId 不是合法的主体标识");
  if (!IDENTIFIER_PATTERN.test(input.organizationId)) {
    throw new CloudDriveMcpTokenError("organizationId 不是合法的主体标识");
  }
  if (!SCOPES.includes(input.scope)) throw new CloudDriveMcpTokenError("scope 不是受支持的值");
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
    throw new CloudDriveMcpTokenError("ttlSeconds 必须是正整数");
  }

  const issuedAt = input.nowSeconds ?? currentSeconds();
  const payload = {
    v: 1,
    uid: input.userId,
    org: input.organizationId,
    exp: issuedAt + input.ttlSeconds,
    scope: input.scope,
  };
  const payloadSegment = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${TOKEN_PREFIX}.${payloadSegment}`;
  const signature = await sign(signingInput, secret);
  return `${signingInput}.${signature}`;
}

interface RawClaims {
  readonly v: unknown;
  readonly uid: unknown;
  readonly org: unknown;
  readonly exp: unknown;
  readonly scope: unknown;
}

function readClaims(payload: Uint8Array): RawClaims | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as RawClaims;
}

/**
 * 校验 token，返回它绑定的主体；任何格式、签名、过期或配置问题都返回 null。
 *
 * 不区分「格式错误」与「签名错误」：两者对调用方都是无效凭据，细分只会增加探测面。
 * 空签名段、多点、非 JSON payload 都在签名校验之前被拒绝，避免把解析错误变成可观测差异。
 */
export async function verifyCloudDriveMcpToken(
  token: string,
  secret: string | undefined,
  nowSeconds?: number,
): Promise<CloudDriveMcpTokenClaims | null> {
  const trimmedSecret = secret?.trim();
  if (!trimmedSecret) return null;

  const segments = token.split(".");
  if (segments.length !== 3) return null;
  const [version, payloadSegment, signature] = segments;
  if (version !== TOKEN_PREFIX || !payloadSegment || !signature) return null;

  const payload = decodeBase64Url(payloadSegment);
  if (!payload) return null;

  const expected = await sign(`${TOKEN_PREFIX}.${payloadSegment}`, trimmedSecret);
  if (!timingSafeEqual(signature, expected)) return null;

  const claims = readClaims(payload);
  if (claims?.v !== 1) return null;
  if (typeof claims.uid !== "string" || !IDENTIFIER_PATTERN.test(claims.uid)) return null;
  if (typeof claims.org !== "string" || !IDENTIFIER_PATTERN.test(claims.org)) return null;
  if (typeof claims.exp !== "number" || !Number.isInteger(claims.exp)) return null;
  if (!SCOPES.includes(claims.scope as CloudDriveMcpScope)) return null;

  const now = nowSeconds ?? currentSeconds();
  if (claims.exp <= now) return null;

  return {
    userId: claims.uid,
    organizationId: claims.org,
    scope: claims.scope as CloudDriveMcpScope,
    expiresAt: claims.exp,
  };
}

/** 部署配置的 scope 解析：只接受 `read` / `write`，其余值在启动期就应被 schema 拒绝。 */
export function isCloudDriveMcpScope(value: string): value is CloudDriveMcpScope {
  return SCOPES.includes(value as CloudDriveMcpScope);
}
