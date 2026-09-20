import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  buildSkillDownloadUrl,
  generateSkillDownloadToken,
  verifySkillDownloadToken,
} from "../server/services/skill-download-token";
import { initializeSkillModuleConfig } from "../server/testing";

const skill = { id: "skill-1", organizationId: "org-1", name: "demo" };

/**
 * 签名密钥在运行期生成：用例需要一份真实可用的密钥，但任何看起来像密钥的字面量都不得进源码
 * （安全红线），生成一次即用，用完随进程消失。
 */
const SIGNING_KEY = randomBytes(24).toString("base64url");

describe("skill download token", () => {
  // 生成的 token 可被解析为 skill 身份和过期时间。
  test("generates and verifies token", () => {
    initializeSkillModuleConfig({ downloadTokenSigningKeys: [SIGNING_KEY] });
    const token = generateSkillDownloadToken(skill, { expiresInSeconds: 60 });
    expect(verifySkillDownloadToken(token)).toMatchObject({
      skillId: "skill-1",
      organizationId: "org-1",
      skillName: "demo",
    });
  });

  // 篡改签名会导致校验失败。
  test("tampered token returns null", () => {
    initializeSkillModuleConfig({ downloadTokenSigningKeys: [SIGNING_KEY] });
    const token = generateSkillDownloadToken(skill, { expiresInSeconds: 60 });
    const suffix = token.endsWith("a") ? "b" : "a";
    expect(verifySkillDownloadToken(token.slice(0, -1) + suffix)).toBeNull();
  });

  // 密钥轮换期间多 key 并存：只有首个非空项参与签名，其余不会让校验结果漂移。
  test("uses the first non-empty signing key", () => {
    initializeSkillModuleConfig({
      downloadTokenSigningKeys: ["", "  ", SIGNING_KEY, randomBytes(24).toString("base64url")],
    });
    const token = generateSkillDownloadToken(skill, { expiresInSeconds: 60 });
    expect(verifySkillDownloadToken(token)).not.toBeNull();
  });

  // 过期 token 不可再用于下载。
  test("expired token returns null", () => {
    initializeSkillModuleConfig({ downloadTokenSigningKeys: [SIGNING_KEY] });
    const token = generateSkillDownloadToken(skill, { expiresInSeconds: -1 });
    expect(verifySkillDownloadToken(token)).toBeNull();
  });

  // 未配置签名密钥时拒绝生成 token，且错误只报字段名、不回显密钥相关取值。
  test("missing signing key throws without echoing key material", () => {
    initializeSkillModuleConfig({ downloadTokenSigningKeys: ["", " "] });
    let message = "";
    try {
      generateSkillDownloadToken(skill);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("downloadTokenSigningKeys");
    expect(message).not.toContain(SIGNING_KEY);
  });

  // URL 使用配置中的 baseUrl，并附带 token 查询参数。
  test("buildSkillDownloadUrl uses configured base url", () => {
    initializeSkillModuleConfig({ baseUrl: "http://rcs.test", downloadTokenSigningKeys: [SIGNING_KEY] });
    const url = buildSkillDownloadUrl(skill, { expiresInSeconds: 60 });
    expect(url.startsWith("http://rcs.test/skills/demo/download?token=")).toBe(true);
  });

  // 基址带尾部斜杠时不得拼出双斜杠路径（部分代理会把 `//skills` 当成不同路径）。
  test("buildSkillDownloadUrl strips trailing slash from base url", () => {
    initializeSkillModuleConfig({ baseUrl: "http://rcs.test/", downloadTokenSigningKeys: [SIGNING_KEY] });
    const url = buildSkillDownloadUrl(skill, { expiresInSeconds: 60 });
    expect(url.startsWith("http://rcs.test/skills/demo/download?token=")).toBe(true);
  });
});
