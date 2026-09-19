import { beforeEach, describe, expect, mock, test } from "bun:test";
import { skillConfigApi } from "../api/skills";
import { getSkillKey, getSkillLookupKey, normalizeSkillOptionsPayload } from "../lib/skill-resource-access";

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
  // 列表响应直接给数组时，编辑表单也应能解析出可选技能并保留授权视图字段。
  test("normalizes direct skill array payload", () => {
    expect(
      normalizeSkillOptionsPayload([
        {
          id: "skill-1",
          name: "deploy-skill",
          description: "Deploy helper",
          scope: { organizationId: "org-current", visibility: "private" },
          access: { actions: ["read", "update"] },
        },
      ]),
    ).toEqual([
      {
        id: "skill-1",
        key: "org-current/skill-1",
        name: "deploy-skill",
        label: "deploy-skill",
        description: "Deploy helper",
        scope: { organizationId: "org-current", visibility: "private" },
        organizationName: undefined,
      },
    ]);
  });

  // 兼容历史对象包裹结构，避免新旧调用方混用时列表消失。
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
        key: "review-skill",
        name: "review-skill",
        label: "review-skill",
        description: "Review helper",
        scope: undefined,
        organizationName: undefined,
      },
    ]);
  });

  // 跨组织共享技能按归属组织与资源 id 推导查找键，详情与下载才取得到正确的归属内容。
  test("derives cross-organization lookup key from scope", () => {
    const shared = {
      id: "skill-9",
      name: "shared",
      scope: { organizationId: "org-source", visibility: "public" as const },
      organizationName: "Source Team",
    };

    expect(getSkillKey(shared)).toBe("org-source/skill-9");
    expect(getSkillLookupKey(shared)).toBe("org-source/skill-9");
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
