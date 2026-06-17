import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  canManageSkillSharing,
  canWriteSkill,
  getSkillKey,
  getSkillOptionLabel,
  mapSkillOptions,
} from "../lib/skill-resource-access";
import type { ResourceAccess } from "../types/config";

const internalAccess: ResourceAccess = {
  ownership: "internal",
  sourceOrganizationId: "org-current",
  sourceOrganizationName: "Current Team",
  resourceUid: "skill-internal",
  resourceKey: "org-current/skill-internal",
  manageable: true,
  writable: true,
  publicReadable: false,
};

const externalAccess: ResourceAccess = {
  ownership: "external",
  sourceOrganizationId: "org-source",
  sourceOrganizationName: "Source Team",
  resourceUid: "skill-external",
  resourceKey: "org-source/skill-external",
  manageable: false,
  writable: false,
};

beforeEach(() => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ success: true, data: { name: "shared" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  ) as unknown as typeof fetch;
});

describe("skill resource access frontend flow", () => {
  // 同名内部和外部 skill 使用 resourceAccess.resourceKey 区分。
  test("同名 skill 使用 resourceKey 作为稳定 key", () => {
    const internal = { id: "skill-internal", name: "shared", resourceAccess: internalAccess };
    const external = { id: "skill-external", name: "shared", resourceAccess: externalAccess };

    expect(getSkillKey(internal)).toBe("org-current/skill-internal");
    expect(getSkillKey(external)).toBe("org-source/skill-external");
    expect(new Set([getSkillKey(internal), getSkillKey(external)]).size).toBe(2);
  });

  // 外部 skill 不可写、不可管理公开状态。
  test("外部 skill 不显示写操作和公开开关", () => {
    const external = { id: "skill-external", name: "shared", resourceAccess: externalAccess };

    expect(canWriteSkill(external)).toBe(false);
    expect(canManageSkillSharing(external)).toBe(false);
  });

  // 公开开关仍通过 update 方法发送 publicReadable。
  test("公开开关 update 请求携带 publicReadable", async () => {
    const { skillConfigApi } = await import("../api/sdk");

    await skillConfigApi.update("shared", {
      description: "Shared",
      content: "# Shared",
      metadata: {},
      publicReadable: true,
    });

    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toContain("/web/config/skills/shared");
    expect(call[1].method).toBe("PUT");
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({
      data: {
        description: "Shared",
        content: "# Shared",
        metadata: {},
        publicReadable: true,
      },
    });
  });

  // Agent 配置弹窗选项提交值使用 skill uuid，而不是 name/resourceKey。
  test("Agent skill 选项使用 resourceUid 作为提交值", () => {
    const [option] = mapSkillOptions([{ id: "fallback-id", name: "shared", resourceAccess: externalAccess }]);

    expect(option.id).toBe("skill-external");
    expect(option.label).toBe("Source Team/shared");
    expect(option.key).toBe("org-source/skill-external");
  });

  // Skill 展示标签优先使用组织名，缺失时退回组织 ID。
  test("Skill 展示标签使用组织名和 skill 名", () => {
    expect(getSkillOptionLabel({ id: "skill-internal", name: "shared", resourceAccess: internalAccess })).toBe(
      "Current Team/shared",
    );
    expect(getSkillOptionLabel({ id: "skill-external", name: "shared", resourceAccess: externalAccess })).toBe(
      "Source Team/shared",
    );
    expect(
      getSkillOptionLabel({
        id: "skill-external",
        name: "shared",
        resourceAccess: { ...externalAccess, sourceOrganizationName: undefined },
      }),
    ).toBe("shared");
  });
});
