import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setConfig } from "../config";
import {
  buildSkillDownloadUrl,
  generateSkillDownloadToken,
  verifySkillDownloadToken,
} from "../services/skill-download-token";

const skill = { id: "skill-1", organizationId: "org-1", name: "demo" };
const originalEnv = { ...process.env };

describe("skill download token", () => {
  beforeEach(() => {
    process.env.RCS_API_KEYS = "test-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
    setConfig({ baseUrl: "" });
  });

  // 生成的 token 可被解析为 skill 身份和过期时间。
  test("generates and verifies token", () => {
    const token = generateSkillDownloadToken(skill, { expiresInSeconds: 60 });
    expect(verifySkillDownloadToken(token)).toMatchObject({
      skillId: "skill-1",
      organizationId: "org-1",
      skillName: "demo",
    });
  });

  // 篡改签名会导致校验失败。
  test("tampered token returns null", () => {
    const token = generateSkillDownloadToken(skill, { expiresInSeconds: 60 });
    const suffix = token.endsWith("a") ? "b" : "a";
    expect(verifySkillDownloadToken(token.slice(0, -1) + suffix)).toBeNull();
  });

  // 过期 token 不可再用于下载。
  test("expired token returns null", () => {
    const token = generateSkillDownloadToken(skill, { expiresInSeconds: -1 });
    expect(verifySkillDownloadToken(token)).toBeNull();
  });

  // 缺少签名 key 时拒绝生成 token。
  test("missing signing key throws", () => {
    delete process.env.RCS_API_KEYS;
    expect(() => generateSkillDownloadToken(skill)).toThrow("RCS_API_KEYS is required for skill download token");
  });

  // URL 使用配置中的 baseUrl，并附带 token 查询参数。
  test("buildSkillDownloadUrl uses configured base url", () => {
    setConfig({ baseUrl: "http://rcs.test" });
    const url = buildSkillDownloadUrl(skill, { expiresInSeconds: 60 });
    expect(url.startsWith("http://rcs.test/web/skills/demo/download?token=")).toBe(true);
  });
});
