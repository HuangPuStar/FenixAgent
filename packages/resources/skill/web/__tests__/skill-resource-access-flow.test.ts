import { beforeEach, describe, expect, mock, test } from "bun:test";
import { skillConfigApi } from "../api/skills";
import { normalizeSkillOptionsPayload } from "../lib/skill-resource-access";

beforeEach(() => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ success: true, data: { name: "deploy-skill" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  ) as unknown as typeof fetch;
});

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

  // 公开开关必须走独立权限接口，不能携带正文或 frontmatter。
  test("updates public readability through the access endpoint", async () => {
    await skillConfigApi.updateAccess("deploy-skill", true);

    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toContain("/web/config/skills/deploy-skill/access");
    expect(call[1].method).toBe("PUT");
    expect(JSON.parse(call[1].body)).toEqual({ publicReadable: true });
  });
});
