import { createHmac, timingSafeEqual } from "node:crypto";
import { getSkillConfig } from "../config";

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

/**
 * 取签名密钥。
 *
 * 密钥来自模块配置（宿主 `RCS_API_KEYS` 的逗号分隔列表），本包不再直读 `process.env`：环境变量的
 * 真相来源是宿主 `apps/server/src/env.ts`。取第一个非空项即宿主既有语义（签名用首 key）。
 * 密钥材料只在此函数内流转，调用方与错误信息都不得回显它。
 */
function getSigningKey(): string | null {
  return (
    getSkillConfig()
      .downloadTokenSigningKeys.map((key) => key.trim())
      .filter(Boolean)[0] ?? null
  );
}

function signPayload(encodedPayload: string, key: string): string {
  return createHmac("sha256", key).update(encodedPayload).digest("base64url");
}

/** 生成短期 skill zip 下载 token。 */
export function generateSkillDownloadToken(skill: SkillTokenInput, options?: { expiresInSeconds?: number }): string {
  const key = getSigningKey();
  // 只报字段名与来源，不回显任何密钥材料；宿主 env 必填 RCS_API_KEYS，走到这里说明装配漏了模块配置。
  if (!key) throw new Error("Skill 下载 token 缺少签名密钥：模块配置 downloadTokenSigningKeys 为空");

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

/**
 * 构建带签名 token 的 skill zip 下载 URL。
 *
 * baseUrl 由宿主经模块配置注入（宿主 `getBaseUrl()` 的产物），本包不再导入宿主工具。这里防御性去掉
 * 尾部斜杠，避免宿主配置残留 `/` 时拼出 `//skills/...` 这种被某些代理判成不同路径的 URL。
 */
export function buildSkillDownloadUrl(skill: SkillTokenInput, options?: { expiresInSeconds?: number }): string {
  const token = generateSkillDownloadToken(skill, options);
  const baseUrl = getSkillConfig().baseUrl.replace(/\/+$/, "");
  return `${baseUrl}/skills/${encodeURIComponent(skill.name)}/download?token=${token}`;
}
