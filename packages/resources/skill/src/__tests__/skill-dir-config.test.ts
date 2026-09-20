import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { getGlobalSkillsDir, skillSourceDir } from "../server/services/skill-content";
import { initializeSkillModuleConfig } from "../server/testing";

/**
 * Skill 模块配置的读取契约。
 *
 * 本包不解析 env、也不解析 `.env`：`SKILL_DIR` 的默认值与相对路径解析归宿主
 * `apps/server/src/config.ts`（`resolve(env.SKILL_DIR ?? "./data/skills")`），本包只消费宿主注入的
 * 已解析结果。这里覆盖的是本包那一半——读到的值与路径拼接是否来自模块配置，以及配置非法时是否
 * 报得出字段、又不泄漏字段值。
 *
 * 宿主侧的 SKILL_DIR 默认值与相对路径解析用例原在本文件（经 `@server/config` 的 `applyEnv`），
 * 随 `@server/*` 切断一并迁出：那两条断言测的是宿主 config 模块，不属于本包职责。
 */

const TEMP_SKILL_DIR = join(tmpdir(), "fenix-skill-config-test");

describe("skill dir config", () => {
  // 内容目录取自模块配置：包内路径拼接的根必须与宿主注入的值一致，不能再有第二处默认值。
  test("skillDir comes from module config", () => {
    initializeSkillModuleConfig({ skillDir: TEMP_SKILL_DIR });
    expect(getGlobalSkillsDir()).toBe(TEMP_SKILL_DIR);
    expect(skillSourceDir("org-1", "demo")).toBe(join(TEMP_SKILL_DIR, "org-1", "demo"));
  });

  // 缺字段时报出字段路径：宿主漏装配一个必填项时就地失败，而不是等到拼接下载 URL 时才以异常行为暴露。
  test("missing field reports the field path", () => {
    resetAllStubs();
    initializeTestApplicationInfrastructure({
      moduleConfigs: { skill: { skillDir: TEMP_SKILL_DIR, downloadTokenSigningKeys: [] } },
    });
    expect(() => getGlobalSkillsDir()).toThrow("baseUrl");
  });

  // 校验失败只报字段路径与错误码，不回显字段值：本配置含签名密钥，错误信息会被日志与响应带走。
  test("validation error does not echo field values", () => {
    const secretValue = "zz-do-not-echo-zz";
    resetAllStubs();
    initializeTestApplicationInfrastructure({
      moduleConfigs: {
        skill: { skillDir: "", baseUrl: "http://rcs.test", downloadTokenSigningKeys: [secretValue] },
      },
    });
    let message = "";
    try {
      getGlobalSkillsDir();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("skillDir");
    expect(message).not.toContain(secretValue);
  });

  // 空串不是"没配置"：宿主必须给出可用的基址，否则相对地址会拼出无效下载链接。
  test("empty baseUrl is rejected", () => {
    resetAllStubs();
    initializeTestApplicationInfrastructure({
      moduleConfigs: { skill: { skillDir: TEMP_SKILL_DIR, baseUrl: "", downloadTokenSigningKeys: [] } },
    });
    expect(() => getGlobalSkillsDir()).toThrow("baseUrl");
  });
});
