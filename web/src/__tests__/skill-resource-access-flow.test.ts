import { describe, expect, test } from "bun:test";
import { normalizeSkillOptionsPayload } from "../lib/skill-resource-access";

describe("skill resource access flow", () => {
  // SkillConfigApi.list 当前直接返回数组，编辑表单也应能解析出可选技能
  test("normalizes direct skill array payload", () => {
    expect(
      normalizeSkillOptionsPayload([
        {
          id: "skill-1",
          name: "deploy-skill",
          description: "Deploy helper",
        },
      ]),
    ).toEqual([
      {
        id: "skill-1",
        key: "skill-1",
        name: "deploy-skill",
        label: "deploy-skill",
        description: "Deploy helper",
        resourceAccess: undefined,
      },
    ]);
  });

  // 兼容历史对象包裹结构，避免新旧调用方混用时列表消失
  test("normalizes legacy wrapped skill payload", () => {
    expect(
      normalizeSkillOptionsPayload({
        skills: [
          {
            id: "skill-2",
            name: "review-skill",
            description: "Review helper",
          },
        ],
      }),
    ).toEqual([
      {
        id: "skill-2",
        key: "skill-2",
        name: "review-skill",
        label: "review-skill",
        description: "Review helper",
        resourceAccess: undefined,
      },
    ]);
  });
});
