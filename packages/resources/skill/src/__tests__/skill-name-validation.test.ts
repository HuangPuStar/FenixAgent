import { describe, expect, mock, test } from "bun:test";
import { ValidationError } from "@fenix/platform-sdk";
import { skillResource } from "../server/access/skill-resource";
import { SkillFacade } from "../server/facades/skill-facade";
import { validateSkillName } from "../server/services/skill-content";
import { createStubSkillService } from "../server/testing";
import { createFakeAccessControl, createRecordingScopeStore, testActor } from "./fixtures";

const invalidNames = [
  "中文技能",
  "My-skill",
  "my_skill",
  "my.skill",
  "my skill",
  " demo",
  "demo ",
  "demo\n",
  "-demo",
  "demo-",
  "demo--skill",
  "a".repeat(65),
  "../escape",
  "",
  "   ",
];

describe("Skill 名称格式", () => {
  // 创建必须在资源行写入前拒绝非法名称，避免文件校验失败后留下垃圾数据。
  test.each(invalidNames)("创建拒绝非法名称 %j 且不写资源行", async (name) => {
    const create = mock(async () => undefined);
    const { store } = createRecordingScopeStore({ organizationId: "org-1", visibility: "private" });
    const facade = new SkillFacade(createStubSkillService({ create }), {
      accessControl: createFakeAccessControl(),
      resource: skillResource.definition,
      scopeStore: store,
    });

    await expect(
      facade.create(testActor(), { name, data: { description: "", content: "Body" } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(create).not.toHaveBeenCalled();
  });

  // 标准允许纯数字、单字符和 64 字符边界，不要求名称一定包含连字符。
  test.each(["a", "9", "123", "my-skill-2", "a".repeat(64)])("接受合法名称 %s", (name) => {
    expect(validateSkillName(name)).toBe(name);
  });
});
