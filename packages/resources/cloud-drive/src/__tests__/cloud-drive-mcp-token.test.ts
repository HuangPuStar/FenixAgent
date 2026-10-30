import { describe, expect, test } from "bun:test";
import {
  type CloudDriveMcpScope,
  CloudDriveMcpTokenError,
  issueCloudDriveMcpToken,
  verifyCloudDriveMcpToken,
} from "../server/mcp/token";

const SECRET = "test-secret-value-do-not-log";
const NOW = 1_700_000_000;

function issue(overrides: Partial<Parameters<typeof issueCloudDriveMcpToken>[0]> = {}) {
  return issueCloudDriveMcpToken({
    userId: "user-a",
    organizationId: "org-1",
    scope: "read",
    ttlSeconds: 3600,
    secret: SECRET,
    nowSeconds: NOW,
    ...overrides,
  });
}

/** 用同一密钥签一段自定义 payload，用来构造「签名有效但声明非法」的 token。 */
async function signPayload(payload: unknown, secret = SECRET): Promise<string> {
  const encode = (bytes: Uint8Array) => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const payloadSegment = encode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`cd1.${payloadSegment}`));
  return `cd1.${payloadSegment}.${encode(new Uint8Array(signature))}`;
}

describe("CloudDrive MCP token", () => {
  // 正常签发后必须能校验回同一主体与作用域，且过期时间按 TTL 计算。
  test("签发的 token 可校验出主体、作用域与过期时间", async () => {
    const token = await issue({ scope: "write", ttlSeconds: 7200 });

    const claims = await verifyCloudDriveMcpToken(token, SECRET, NOW + 1);

    expect(claims).toEqual({
      userId: "user-a",
      organizationId: "org-1",
      scope: "write",
      expiresAt: NOW + 7200,
    });
    expect(token.startsWith("cd1.")).toBe(true);
  });

  // token 是 bearer 明文，但绝不能包含签名密钥；泄漏密钥等于所有用户失效。
  test("token 文本不包含签名密钥", async () => {
    const token = await issue();
    expect(token).not.toContain(SECRET);
  });

  // 篡改 payload（改 uid 或 scope）必须失败，即便签名段保持原样。
  test("篡改 payload 后校验失败", async () => {
    const token = await issue();
    const [version, payload, signature] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const forgedPayload = Buffer.from(JSON.stringify({ ...decoded, uid: "user-b" })).toString("base64url");

    expect(await verifyCloudDriveMcpToken(`${version}.${forgedPayload}.${signature}`, SECRET, NOW)).toBeNull();
  });

  // 篡改签名段必须失败；这是常数时间比较覆盖的核心分支。
  test("篡改签名后校验失败", async () => {
    const token = await issue();
    const [version, payload] = token.split(".");
    const forgedSignature = "A".repeat(43);

    expect(await verifyCloudDriveMcpToken(`${version}.${payload}.${forgedSignature}`, SECRET, NOW)).toBeNull();
  });

  // 换密钥后旧 token 必须整体失效（轮换语义）。
  test("使用错误密钥校验失败", async () => {
    const token = await issue();
    expect(await verifyCloudDriveMcpToken(token, "another-secret", NOW)).toBeNull();
  });

  // 过期判断必须严格：exp 等于当前秒即视为过期，避免边界上的额外一秒。
  test("过期 token 校验失败", async () => {
    const token = await issue({ ttlSeconds: 60 });
    expect(await verifyCloudDriveMcpToken(token, SECRET, NOW + 59)).not.toBeNull();
    expect(await verifyCloudDriveMcpToken(token, SECRET, NOW + 60)).toBeNull();
  });

  // 部署未配置密钥时必须拒绝签发与校验，而不是签发无签名 token。
  test("密钥缺失时拒绝签发且校验返回 null", async () => {
    await expect(issue({ secret: undefined })).rejects.toBeInstanceOf(CloudDriveMcpTokenError);

    const token = await issue();
    expect(await verifyCloudDriveMcpToken(token, undefined, NOW)).toBeNull();
    expect(await verifyCloudDriveMcpToken(token, "   ", NOW)).toBeNull();
  });

  // 作用域只接受 read/write：签名有效但声明了未知 scope 的 token 仍须拒绝。
  test("未知 scope 的 payload 校验失败", async () => {
    const token = await signPayload({ v: 1, uid: "user-a", org: "org-1", exp: NOW + 60, scope: "delete" });
    expect(await verifyCloudDriveMcpToken(token, SECRET, NOW)).toBeNull();
  });

  // 版本号、缺失字段与非对象 payload 都必须在签名之后被判为非法。
  test("声明字段非法时校验失败", async () => {
    const cases: unknown[] = [
      { v: 2, uid: "user-a", org: "org-1", exp: NOW + 60, scope: "read" },
      { v: 1, uid: "", org: "org-1", exp: NOW + 60, scope: "read" },
      { v: 1, uid: "user-a", org: "org-1", exp: "soon", scope: "read" },
      { v: 1, uid: "user-a", org: "org-1", scope: "read" },
      ["not-an-object"],
    ];

    for (const payload of cases) {
      const token = await signPayload(payload);
      expect(await verifyCloudDriveMcpToken(token, SECRET, NOW)).toBeNull();
    }
  });

  // 形态错误（段数、空段、非 base64url）在解析前就被拒绝，且不抛异常。
  test("形态错误的 token 返回 null", async () => {
    const cases = ["", "cd1", "cd1.", "cd1..", "cd1.abc", "cd1.a.b.c", "im_foo.bar", "cd1.%%%%.***"];
    for (const token of cases) {
      expect(await verifyCloudDriveMcpToken(token, SECRET, NOW)).toBeNull();
    }
  });

  // 非法主体与非法 TTL 在签发阶段直接失败，避免把错误带进 token 或日志。
  test("非法主体或 TTL 拒绝签发", async () => {
    const invalid: Array<Partial<Parameters<typeof issueCloudDriveMcpToken>[0]>> = [
      { userId: "../etc/passwd" },
      { organizationId: "org 1" },
      { ttlSeconds: 0 },
      { ttlSeconds: 1.5 },
      { scope: "admin" as CloudDriveMcpScope },
    ];

    for (const overrides of invalid) {
      await expect(issue(overrides)).rejects.toBeInstanceOf(CloudDriveMcpTokenError);
    }
  });
});
