import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ActorContext } from "@fenix/platform-sdk";
import { ConflictError, NotFoundError } from "@server/errors";
import { resetTestAuth, setTestAuth } from "@server/plugins/auth";
import { setTestOrgContext } from "@server/services/org-context";
import { readJson, resetAllStubs, stubAuthApi, stubEnvironmentRepo } from "@server/test-utils/helpers";
import {
  authorizedSkill,
  authorizedSkillDetail,
  installSkillModuleStub,
  resetSkillModuleStub,
  testActor,
} from "./fixtures";

/**
 * `/web/config/skills` 协议层用例。
 *
 * 授权、可见性与名称解析都在应用 Facade 内，本文件只覆盖协议层职责：参数校验、请求映射、视图映射
 * （决策 D2：`scope + access.actions`）与错误码映射。Facade 行为——文件与资源行的补偿写入、跨组织
 * 名称解析、导入冲突判定——由 `skill-facade` 用例覆盖。
 */

const skillsRoute = (await import("../server/routes/web/config/skills")).default;

function authenticate(organizationId = "org-1") {
  setTestAuth({
    user: { id: "user-1", email: "user-1@example.test", name: "Tester" },
    authContext: { organizationId, userId: "user-1", role: "owner" },
  });
  setTestOrgContext({ organizationId, userId: "user-1", role: "owner" });
}

function request(path: string, init?: RequestInit) {
  return skillsRoute.handle(new Request(`http://localhost${path}`, init));
}

function jsonRequest(path: string, method: string, body: Record<string, unknown> = {}) {
  return request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 构造一次合法的上传表单：manifest 与文件一一对应。 */
function uploadForm(overrides: { manifest?: string; conflictStrategy?: string; files?: number } = {}): FormData {
  const form = new FormData();
  const count = overrides.files ?? 1;
  form.set("manifest", overrides.manifest ?? JSON.stringify([{ skillName: "demo", relativePath: "SKILL.md" }]));
  if (overrides.conflictStrategy !== undefined) form.set("conflictStrategy", overrides.conflictStrategy);
  for (let index = 0; index < count; index += 1) {
    form.append("files", new File(["# demo"], "SKILL.md", { type: "text/markdown" }));
  }
  return form;
}

describe("round44 Skill 配置路由", () => {
  beforeEach(() => {
    resetAllStubs();
    resetSkillModuleStub();
    // 默认装入全未打桩的替身：参数校验用例在被测方法调用之前就应失败，任何越界调用都会立即暴露。
    installSkillModuleStub();
    authenticate();
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
    resetSkillModuleStub();
  });

  // 未认证请求必须在 session 守卫处终止，不能进入资源模块。
  test("未认证列表返回 401", async () => {
    resetTestAuth();
    setTestOrgContext(null);
    stubAuthApi({ getSession: async () => null, verifyApiKey: async () => ({ valid: false }) });
    stubEnvironmentRepo({ getBySecret: async () => null });
    let listed = false;
    installSkillModuleStub({
      facade: {
        list: async () => {
          listed = true;
          return { items: [], total: 0 };
        },
      },
    });

    expect((await request("/config/skills")).status).toBe(401);
    expect(listed).toBeFalse();
  });

  // 列表把可信主体（含 active organization 与全量成员关系）原样交给 Facade，协议层不做主体改写。
  test("列表把可信主体交给 Facade 并返回 skills 数组", async () => {
    let received: ActorContext | undefined;
    installSkillModuleStub({
      facade: {
        list: async (actor) => {
          received = actor;
          return { items: [], total: 0 };
        },
      },
    });

    const response = await request("/config/skills");

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ success: true, data: { skills: [] } });
    expect(received).toEqual(testActor());
  });

  // 列表项按决策 D2 返回归属 scope 与有效动作，组织名由身份名录批量补齐。
  test("列表返回 scope、access 与组织名", async () => {
    installSkillModuleStub({
      facade: {
        list: async () => ({
          items: [
            authorizedSkill({
              id: "skill-external",
              name: "shared",
              organizationId: "org-source",
              visibility: "public",
              actions: ["read"],
            }),
          ],
          total: 1,
        }),
      },
      identity: { listOrganizationNames: async () => new Map([["org-source", "Source Team"]]) },
    });

    const body = await readJson(await request("/config/skills"));

    expect(body.data.skills[0]).toMatchObject({
      id: "skill-external",
      name: "shared",
      enabled: true,
      organizationName: "Source Team",
      scope: { organizationId: "org-source", ownerUserId: "user-1", visibility: "public" },
      access: { actions: ["read"] },
    });
  });

  // 详情按路径名称解析（用户看到的是名称），正文来自 Facade 的详情视图。
  test("详情按名称读取并返回正文", async () => {
    let receivedName = "";
    installSkillModuleStub({
      facade: {
        readDetail: async (_actor, nameOrKey) => {
          receivedName = nameOrKey;
          return authorizedSkillDetail({ content: "# demo" });
        },
      },
    });

    const response = await request("/config/skills/demo");

    expect(response.status).toBe(200);
    expect(receivedName).toBe("demo");
    expect(await readJson(response)).toMatchObject({
      success: true,
      data: { name: "demo", content: "# demo", metadata: {} },
    });
  });

  // 含斜杠的资源键不匹配单段 `:name` 路由，必须在进入 Facade 前就 404。
  test("详情路径拒绝含斜杠的资源键", async () => {
    let queried = false;
    installSkillModuleStub({
      facade: {
        readDetail: async () => {
          queried = true;
          return authorizedSkillDetail();
        },
      },
    });

    const response = await request("/config/skills/org-2/shared");

    expect(response.status).toBe(404);
    expect(queried).toBeFalse();
  });

  // 不可见与不存在返回同一个 404：区分两者会让名称成为跨组织探测面。
  test("详情不存在时返回 404", async () => {
    installSkillModuleStub({ facade: { readDetail: async () => undefined } });

    const response = await request("/config/skills/missing");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });

  // 归档按归属组织目录重建；归属组织缺失是数据异常而不是 404，必须显式失败而不是回落到别的目录。
  test("下载缺少归属组织时返回 500", async () => {
    installSkillModuleStub({
      facade: {
        // 归属范围缺 organizationId（个人资源形状）：组织资源的归档路径无法推导。
        get: async () => ({ ...authorizedSkill(), scope: { ownerUserId: "user-1", visibility: "private" } }),
      },
    });

    const response = await request("/config/skills/demo/download");

    expect(response.status).toBe(500);
  });

  // 不可见或不存在时不构建归档，直接映射为 404。
  test("下载不存在技能返回 404", async () => {
    installSkillModuleStub({ facade: { get: async () => undefined } });

    const response = await request("/config/skills/missing/download");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });

  // 创建缺少名称时在调用 Facade 之前失败。
  test("创建缺少名称返回 400", async () => {
    const response = await jsonRequest("/config/skills", "POST", { data: { description: "d", content: "c" } });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await readJson(response))).toContain("Missing 'name' field");
  });

  // 创建缺少内容时不启动写入编排。
  test("创建缺少内容返回 400", async () => {
    const response = await jsonRequest("/config/skills", "POST", { name: "demo", data: { description: "d" } });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await readJson(response))).toContain("Missing required field: data.content");
  });

  // 同组织同名由 Facade 的唯一索引判定为 409：协议层不做"先查同名再写"的预检。
  test("创建同名技能返回 409", async () => {
    installSkillModuleStub({
      facade: {
        create: async () => {
          throw new ConflictError("Skill 'demo' already exists");
        },
      },
    });

    const response = await jsonRequest("/config/skills", "POST", {
      name: "demo",
      data: { description: "d", content: "c" },
    });

    expect(response.status).toBe(409);
    expect(await readJson(response)).toMatchObject({ success: false, error: { code: "ALREADY_EXISTS" } });
  });

  // 公开受众在创建期即写入归属范围，协议层必须把 publicReadable 原样传下去。
  test("创建把 publicReadable 传给 Facade", async () => {
    let received: { name?: string; publicReadable?: boolean; content?: string } = {};
    installSkillModuleStub({
      facade: {
        create: async (_actor, input) => {
          received = {
            name: input.name,
            content: input.data.content,
            ...(input.publicReadable === undefined ? {} : { publicReadable: input.publicReadable }),
          };
          return authorizedSkill({ name: input.name, visibility: "public" });
        },
      },
    });

    const response = await jsonRequest("/config/skills", "POST", {
      name: "demo",
      data: { description: "d", content: "# demo", publicReadable: true },
    });

    expect(response.status).toBe(200);
    expect(received).toEqual({ name: "demo", content: "# demo", publicReadable: true });
    expect(await readJson(response)).toMatchObject({ data: { name: "demo", scope: { visibility: "public" } } });
  });

  // 更新缺少内容时不得调用写入链路。
  test("更新缺少内容返回 400", async () => {
    const response = await jsonRequest("/config/skills/demo", "PUT", { data: { description: "d" } });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await readJson(response))).toContain("Missing required field: data.content");
  });

  // 更新以路径参数为定位键，并把可选的公开受众一并交给 Facade。
  test("更新按路径名称写入", async () => {
    let received: { nameOrKey?: string; publicReadable?: boolean } = {};
    installSkillModuleStub({
      facade: {
        update: async (_actor, nameOrKey, _data, options) => {
          received = {
            nameOrKey,
            ...(options?.publicReadable === undefined ? {} : { publicReadable: options.publicReadable }),
          };
          return authorizedSkill({ name: "renamed" });
        },
      },
    });

    const response = await jsonRequest("/config/skills/renamed", "PUT", {
      data: { description: "新描述", content: "# 新内容", publicReadable: false },
    });

    expect(response.status).toBe(200);
    expect(received).toEqual({ nameOrKey: "renamed", publicReadable: false });
    expect(await readJson(response)).toMatchObject({ data: { name: "renamed" } });
  });

  // 公开受众走独立入口：协议层不经过内容写入路径，也就不会重写 SKILL.md。
  test("公开受众更新走独立入口", async () => {
    let received: { nameOrKey?: string; publicReadable?: boolean } = {};
    installSkillModuleStub({
      facade: {
        setPublicReadable: async (_actor, nameOrKey, publicReadable) => {
          received = { nameOrKey, publicReadable };
          return authorizedSkill({ visibility: "public" });
        },
      },
    });

    const response = await jsonRequest("/config/skills/demo/access", "PUT", { publicReadable: true });

    expect(response.status).toBe(200);
    expect(received).toEqual({ nameOrKey: "demo", publicReadable: true });
    expect(await readJson(response)).toMatchObject({ data: { scope: { visibility: "public" } } });
  });

  // 删除不可见或不存在时明确 404，不能伪造幂等成功。
  test("删除不存在技能返回 404", async () => {
    installSkillModuleStub({
      facade: {
        remove: async () => {
          throw new NotFoundError("Skill 'missing' not found");
        },
      },
    });

    const response = await request("/config/skills/missing", { method: "DELETE" });

    expect(response.status).toBe(404);
    expect(await readJson(response)).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  });

  // 删除成功按路径名称定位，并返回稳定的空 data。
  test("删除内部技能返回成功", async () => {
    let removed = "";
    installSkillModuleStub({
      facade: {
        remove: async (_actor, nameOrKey) => {
          removed = nameOrKey;
        },
      },
    });

    const response = await request("/config/skills/demo", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(removed).toBe("demo");
    expect(await readJson(response)).toEqual({ success: true, data: null });
  });

  // 上传非 multipart 请求时应映射为表单解析验证错误。
  test("上传无法解析表单返回 400", async () => {
    const response = await request("/config/skills/upload", { method: "POST", body: "invalid" });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await readJson(response))).toContain("上传表单解析失败");
  });

  // 上传缺失 manifest 时不得进入导入编排。
  test("上传缺少 manifest 返回 400", async () => {
    const response = await request("/config/skills/upload", { method: "POST", body: new FormData() });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await readJson(response))).toContain("缺少 manifest");
  });

  // 上传 manifest 不是 JSON 数组时必须被拒绝。
  test("上传无效 manifest 返回 400", async () => {
    const form = new FormData();
    form.set("manifest", "{}");

    const response = await request("/config/skills/upload", { method: "POST", body: form });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await readJson(response))).toContain("manifest 格式无效");
  });

  // 上传仅接受 ignore 与 overwrite 两种冲突策略。
  test("上传拒绝未知冲突策略", async () => {
    const response = await request("/config/skills/upload", {
      method: "POST",
      body: uploadForm({ manifest: "[]", conflictStrategy: "replace", files: 0 }),
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await readJson(response))).toContain("冲突策略无效");
  });

  // manifest 与文件数量不一致时文件与技能会错位，必须在导入前失败。
  test("上传文件数量不匹配返回 400", async () => {
    const response = await request("/config/skills/upload", {
      method: "POST",
      body: uploadForm({ files: 0 }),
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await readJson(response))).toContain("上传文件与 manifest 数量不一致");
  });

  // 冲突是"需要用户决策"而不是请求非法：返回 409 并带上冲突清单与可用策略。
  test("上传冲突返回 409 及允许策略", async () => {
    installSkillModuleStub({
      facade: {
        importDirectories: async () => ({
          imported: [],
          skipped: [],
          conflicts: [{ name: "demo", enabled: true, path: "/skills/org-1/demo/SKILL.md" }],
        }),
      },
    });

    const response = await request("/config/skills/upload", { method: "POST", body: uploadForm() });
    const body = await readJson(response);

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      success: false,
      error: { code: "SKILL_CONFLICT" },
      data: { conflicts: [{ name: "demo" }], allowedStrategies: ["ignore", "overwrite"] },
    });
  });

  // 上传成功把表单解析出的文件与冲突策略交给 Facade，并原样回传导入结果。
  test("上传成功把文件与策略交给 Facade", async () => {
    let received: { files?: { skillName: string; relativePath: string }[]; strategy?: string } = {};
    installSkillModuleStub({
      facade: {
        importDirectories: async (_actor, files, strategy) => {
          received = {
            files: files.map((file) => ({ skillName: file.skillName, relativePath: file.relativePath })),
            ...(strategy === undefined ? {} : { strategy }),
          };
          return { imported: [authorizedSkill()], skipped: [], conflicts: [] };
        },
      },
    });

    const response = await request("/config/skills/upload", {
      method: "POST",
      body: uploadForm({ conflictStrategy: "overwrite" }),
    });

    expect(received).toEqual({
      files: [{ skillName: "demo", relativePath: "SKILL.md" }],
      strategy: "overwrite",
    });
    expect(await readJson(response)).toMatchObject({
      success: true,
      data: { imported: [{ name: "demo" }], skipped: [], conflicts: [] },
    });
  });
});
