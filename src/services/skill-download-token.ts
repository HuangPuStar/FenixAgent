import { createHmac, timingSafeEqual } from "node:crypto";
import { getBaseUrl } from "../config";

interface SkillTokenInput {
  id: string;
  organizationId: string;
  name: string;
}

interface SkillDownloadPayload {
  type: "skill-download";
  skillId: string;
  organizationId: string;
  skillName: string;
  iat: number;
  exp: number;
}

function getSigningKey(): string | null {
  return (
    process.env.RCS_API_KEYS?.split(",")
      .map((key) => key.trim())
      .filter(Boolean)[0] ?? null
  );
}

function signPayload(encodedPayload: string, key: string): string {
  return createHmac("sha256", key).update(encodedPayload).digest("base64url");
}

/** 生成短期 skill zip 下载 token。 */
export function generateSkillDownloadToken(skill: SkillTokenInput, options?: { expiresInSeconds?: number }): string {
  const key = getSigningKey();
  if (!key) throw new Error("RCS_API_KEYS is required for skill download token");

  const iat = Math.floor(Date.now() / 1000);
  const payload: SkillDownloadPayload = {
    type: "skill-download",
    skillId: skill.id,
    organizationId: skill.organizationId,
    skillName: skill.name,
    iat,
    exp: iat + (options?.expiresInSeconds ?? 300),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  return `${encodedPayload}.${signPayload(encodedPayload, key)}`;
}

/** 验证 skill zip 下载 token，失败或过期时返回 null。 */
export function verifySkillDownloadToken(token: string): SkillDownloadPayload | null {
  const key = getSigningKey();
  if (!key) return null;

  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra !== undefined) return null;

  const expected = signPayload(encodedPayload, key);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf-8"),
    ) as Partial<SkillDownloadPayload>;
    if (
      payload.type !== "skill-download" ||
      typeof payload.skillId !== "string" ||
      typeof payload.organizationId !== "string" ||
      typeof payload.skillName !== "string" ||
      typeof payload.exp !== "number" ||
      payload.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload as SkillDownloadPayload;
  } catch {
    return null;
  }
}

/** 构建带签名 token 的 skill zip 下载 URL。 */
export function buildSkillDownloadUrl(skill: SkillTokenInput, options?: { expiresInSeconds?: number }): string {
  const token = generateSkillDownloadToken(skill, options);
  return `${getBaseUrl()}/web/skills/${encodeURIComponent(skill.name)}/download?token=${token}`;
}
