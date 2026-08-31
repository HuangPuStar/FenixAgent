import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { _deps, _resetDeps } from "../services/skill";
import { readJson, resetAllStubs, stubConfigPg } from "../test-utils/helpers";

const skillsRoute = (await import("../routes/web/config/skills")).default;

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

function skill(overrides: Record<string, unknown> = {}) {
  return {
    id: "skill-1",
    name: "demo",
    description: "演示技能",
    metadata: {},
    organizationId: "org-1",
    userId: "user-1",
    createdAt: new Date("2026-08-19T00:00:00.000Z"),
    updatedAt: new Date("2026-08-19T00:00:00.000Z"),
    resourceAccess: {
      ownership: "internal",
      sourceOrganizationId: "org-1",
      resourceUid: "skill-1",
      resourceKey: "org-1/skill-1",
      manageable: true,
      writable: true,
      publicReadable: false,
    },
    ...overrides,
  };
}

function installSkillFs() {
  _deps.skillFs.assertValidSkillName = mock((name: string) => name);
  _deps.skillFs.getSkillMdPath = mock((_root: string, org: string, name: string) => `/skills/${org}/${name}/SKILL.md`);
  _deps.skillFs.getSkillSourceDir = mock((_root: string, org: string, name: string) => `/skills/${org}/${name}`);
  _deps.skillFs.getSkillArchivePath = mock((_root: string, org: string, name: string) => `/skills/${org}/${name}.zip`);
  _deps.skillFs.getSkillOrganizationDir = mock((_root: string, org: string) => `/skills/${org}`);
  _deps.skillFs.readSkillDetailFromMd = mock(async () => ({ metadata: { category: "test" }, content: "# demo" }));
  _deps.skillFs.createBackupDir = mock(async () => "/tmp/skill-backup");
  _deps.skillFs.backupSkillDirs = mock(async () => new Map());
  _deps.skillFs.writeSkillMd = mock(async (dir: string) => `${dir}/SKILL.md`);
  _deps.skillFs.buildSkillArchive = mock(async () => undefined);
  _deps.skillFs.cleanupWrittenSkills = mock(async () => undefined);
  _deps.skillFs.restoreFromBackup = mock(async () => undefined);
  _deps.skillFs.deleteSkillArchive = mock(async () => undefined);
  _deps.skillFs.cleanupBackupDir = mock(async () => undefined);
  _deps.skillFs.deleteSkillDir = mock(async () => undefined);
  _deps.skillFs.groupUploadFiles = mock((files) => new Map([["demo", files]]));
  _deps.skillFs.resolveImportPlan = mock((grouped) => ({ pendingEntries: [...grouped.entries()], skipped: [] }));
  _deps.skillFs.createBackupDir = mock(async () => "/tmp/skill-backup");
  _deps.skillFs.backupSkillDirs = mock(async () => new Map());
  _deps.skillFs.writeImportFiles = mock(async (_dir: string, entries: Array<[string, unknown]>) =>
    entries.map(([name]) => name),
  );
  _deps.skillFs.buildImportedSkillInfos = mock(async () => [
    { name: "demo", description: "导入技能", enabled: true, path: "/skills/org-1/demo" },
  ]);
}

function installConfigStubs() {
  stubConfigPg({
    listSkills: async () => [],
    getSkill: async () => null,
    getSkillByResourceKey: async () => null,
    setSkillPublicReadable: async (_ctx, name, publicReadable) =>
      skill({ name, resourceAccess: { ...skill().resourceAccess, publicReadable } }),
    upsertSkill: async () => "skill-1",
    deleteSkill: async () => true,
  });
}

describe("round44 Skill 配置路由", () => {
  beforeEach(() => {
    resetAllStubs();
    _resetDeps();
    setTestAuth({
      user: { id: "user-1", email: "user@example.test", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    setTestOrgContext({ organizationId: "org-1", userId: "user-1", role: "owner" });
    installSkillFs();
    installConfigStubs();
  });

  afterEach(() => {
    _resetDeps();
    resetTestAuth();
    setTestOrgContext(null);
  });

  // 未认证请求不能进入列表业务服务，即使认证插件最终返回通用错误。
  test("未认证列表请求不调用列表服务", async () => {
    let listed = false;
    stubConfigPg({
      listSkills: async () => {
        listed = true;
        return [];
      },
    });
    resetTestAuth();

    const response = await request("/config/skills");

    expect(response.status).toBe(500);
    expect(listed).toBe(false);
  });

  // 列表必须将当前认证组织传入服务层，保证组织隔离由下层实施。
  test("列表向服务传递当前组织", async () => {
    let organizationId = "";
    stubConfigPg({
      listSkills: async (ctx) => {
        organizationId = ctx.organizationId;
        return [];
      },
    });

    const response = await request("/config/skills");

    expect(response.status).toBe(200);
    expect(organizationId).toBe("org-1");
  });

  // 空列表也必须维持统一的成功响应形状。
  test("列表返回空技能集合", async () => {
    const response = await request("/config/skills");

    expect(await readJson(response)).toEqual({ success: true, data: { skills: [] } });
  });

  // 列表应返回服务层提供的资源访问权限，供前端控制可写状态。
  test("列表返回资源权限", async () => {
    stubConfigPg({ listSkills: async () => [skill()] });

    const response = await request("/config/skills");
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).toContain('"name":"demo"');
  });

  // 普通名称详情读取应走当前组织范围的 getSkill。
  test("详情按名称读取内部技能", async () => {
    let receivedName = "";
    stubConfigPg({
      getSkill: async (_ctx, name) => {
        receivedName = name;
        return skill();
      },
    });

    const response = await request("/config/skills/demo");

    expect(response.status).toBe(200);
    expect(receivedName).toBe("demo");
    expect(JSON.stringify(await readJson(response))).toContain('"content":"# demo"');
  });

  // 含斜杠的 resourceKey 不匹配单段 :name 路由，不能意外进入共享读取逻辑。
  test("详情路径拒绝含斜杠的 resourceKey", async () => {
    let queried = false;
    stubConfigPg({
      getSkillByResourceKey: async () => {
        queried = true;
        return skill();
      },
    });

    const response = await request("/config/skills/org-2/shared");

    expect(response.status).toBe(404);
    expect(queried).toBe(false);
  });

  // 不存在的技能详情应映射为标准的 404 业务错误。
  test("详情不存在时返回 404", async () => {
    const response = await request("/config/skills/missing");

    expect(response.status).toBe(404);
    expect(JSON.stringify(await readJson(response))).toContain('"code":"NOT_FOUND"');
  });

  // 下载缺少元数据标识时不能触碰文件系统，并返回专用错误码。
  test("下载缺少资源标识时返回 500", async () => {
    stubConfigPg({ getSkill: async () => skill({ id: undefined, resourceAccess: {} }) });

    const response = await request("/config/skills/demo/download");

    expect(response.status).toBe(500);
    expect(JSON.stringify(await readJson(response))).toContain('"code":"SKILL_DOWNLOAD_UNAVAILABLE"');
  });

  // 下载找不到技能时必须映射为 404，而不暴露归档实现细节。
  test("下载不存在技能返回 404", async () => {
    const response = await request("/config/skills/missing/download");

    expect(response.status).toBe(404);
    expect(JSON.stringify(await readJson(response))).toContain('"code":"NOT_FOUND"');
  });

  // 创建缺少名称时应在查询和写入之前失败。
  test("创建缺少名称返回 400", async () => {
    const response = await jsonRequest("/config/skills", "POST", { data: { description: "d", content: "c" } });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await readJson(response))).toContain("Missing 'name' field");
  });

  // 创建缺少内容时不能启动文件写入事务。
  test("创建缺少内容返回 400", async () => {
    const response = await jsonRequest("/config/skills", "POST", { name: "demo", data: { description: "d" } });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await readJson(response))).toContain("Missing required field: data.content");
  });

  // 当前组织内部同名技能必须返回冲突，避免覆盖既有配置。
  test("创建内部同名技能返回 409", async () => {
    stubConfigPg({ getSkill: async () => skill() });

    const response = await jsonRequest("/config/skills", "POST", {
      name: "demo",
      data: { description: "d", content: "c" },
    });

    expect(response.status).toBe(409);
    expect(JSON.stringify(await readJson(response))).toContain('"code":"CONFLICT"');
  });

  // 共享的同名只读技能不应阻塞当前组织创建自己的副本。
  test("创建允许与外部共享技能同名", async () => {
    let calls = 0;
    stubConfigPg({
      getSkill: async () => {
        calls += 1;
        return calls === 1 ? skill({ resourceAccess: { ownership: "external", writable: false } }) : skill();
      },
    });

    const response = await jsonRequest("/config/skills", "POST", {
      name: "demo",
      data: { description: "d", content: "c", publicReadable: true },
    });

    expect(response.status).toBe(200);
    expect(JSON.stringify(await readJson(response))).toContain('"name":"demo"');
  });

  // 创建成功应把 publicReadable 作为资源权限选项传给持久化层。
  test("创建透传公开读取选项", async () => {
    let options: Record<string, unknown> = {};
    let calls = 0;
    stubConfigPg({
      getSkill: async () => {
        calls += 1;
        return calls === 1 ? null : skill();
      },
      upsertSkill: async (_ctx, _name, _data, value) => {
        options = value;
        return "skill-1";
      },
    });

    const response = await jsonRequest("/config/skills", "POST", {
      name: "demo",
      data: { description: "d", content: "c", publicReadable: true },
    });

    expect(response.status).toBe(200);
    expect(options).toMatchObject({ publicReadable: true, auditAction: "set" });
  });

  // 更新缺少内容时不得调用写入链路。
  test("更新缺少内容返回 400", async () => {
    const response = await jsonRequest("/config/skills/demo", "PUT", { data: { description: "d" } });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await readJson(response))).toContain("Missing required field: data.content");
  });

  // 更新使用路径参数作为目标名称，并返回新的资源访问描述。
  test("更新按路径名称写入技能", async () => {
    let name = "";
    stubConfigPg({
      upsertSkill: async (_ctx, receivedName) => {
        name = receivedName;
        return "skill-1";
      },
      getSkill: async () => skill(),
    });

    const response = await jsonRequest("/config/skills/renamed", "PUT", {
      data: { description: "新描述", content: "# 新内容" },
    });

    expect(response.status).toBe(200);
    expect(name).toBe("renamed");
    expect(JSON.stringify(await readJson(response))).toContain('"name":"renamed"');
  });

  // 公开状态走独立权限接口，不得复用内容保存路由。
  test("公开状态更新不写入 SKILL.md", async () => {
    let writeCalled = false;
    let receivedPublicReadable: boolean | undefined;
    _deps.skillFs.writeSkillMd = mock(async () => {
      writeCalled = true;
      return "/skills/org-1/demo/SKILL.md";
    });
    stubConfigPg({
      setSkillPublicReadable: async (_ctx, name, publicReadable) => {
        receivedPublicReadable = publicReadable;
        return skill({ name, resourceAccess: { ...skill().resourceAccess, publicReadable } });
      },
    });

    const response = await jsonRequest("/config/skills/demo/access", "PUT", { publicReadable: true });

    expect(response.status).toBe(200);
    expect(receivedPublicReadable).toBe(true);
    expect(writeCalled).toBe(false);
    expect(JSON.stringify(await readJson(response))).toContain('"publicReadable":true');
  });

  // 删除目标不存在时必须明确反馈 404，不能伪造幂等成功。
  test("删除不存在技能返回 404", async () => {
    const response = await request("/config/skills/missing", { method: "DELETE" });

    expect(response.status).toBe(404);
    expect(JSON.stringify(await readJson(response))).toContain('"code":"NOT_FOUND"');
  });

  // 删除内部技能必须向当前组织范围的持久化服务传递名称。
  test("删除内部技能返回成功", async () => {
    let deletedName = "";
    stubConfigPg({
      getSkill: async () => skill(),
      deleteSkill: async (_ctx, name) => {
        deletedName = name;
        return true;
      },
    });

    const response = await request("/config/skills/demo", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(deletedName).toBe("demo");
    expect(await readJson(response)).toEqual({ success: true, data: null });
  });

  // 外部只读技能删除会由服务层抛出权限错误，路由不得继续调用删除持久化操作。
  test("删除外部只读技能不调用删除服务", async () => {
    let deleted = false;
    stubConfigPg({
      getSkill: async () => skill({ resourceAccess: { writable: false } }),
      deleteSkill: async () => {
        deleted = true;
        return true;
      },
    });

    const response = await request("/config/skills/demo", { method: "DELETE" });

    expect(response.status).toBe(500);
    expect(deleted).toBe(false);
  });

  // 上传非 multipart 请求时应映射为表单解析验证错误。
  test("上传无法解析表单返回 400", async () => {
    const response = await request("/config/skills/upload", { method: "POST", body: "invalid" });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await readJson(response))).toContain("上传表单解析失败");
  });

  // 上传缺失 manifest 时不得进入导入服务。
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
    const form = new FormData();
    form.set("manifest", "[]");
    form.set("conflictStrategy", "replace");

    const response = await request("/config/skills/upload", { method: "POST", body: form });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await readJson(response))).toContain("冲突策略无效");
  });

  // manifest 与文件数量不一致时不能调用导入流程。
  test("上传文件数量不匹配返回 400", async () => {
    const form = new FormData();
    form.set("manifest", JSON.stringify([{ skillName: "demo", relativePath: "SKILL.md" }]));

    const response = await request("/config/skills/upload", { method: "POST", body: form });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await readJson(response))).toContain("上传文件与 manifest 数量不一致");
  });

  // 导入发现当前组织同名技能时必须返回可供客户端重试的策略列表。
  test("上传冲突返回 409 及允许策略", async () => {
    stubConfigPg({ getSkill: async () => skill() });
    const form = new FormData();
    form.set("manifest", JSON.stringify([{ skillName: "demo", relativePath: "SKILL.md" }]));
    form.append("files", new File(["# demo"], "SKILL.md", { type: "text/markdown" }));

    const response = await request("/config/skills/upload", { method: "POST", body: form });
    const body = await readJson(response);

    expect(response.status).toBe(409);
    expect(JSON.stringify(body)).toContain('"code":"SKILL_CONFLICT"');
  });

  // 导入验证异常应转换为 400，避免被误报为服务故障。
  test("上传导入验证异常返回 400", async () => {
    _deps.skillFs.groupUploadFiles = mock(() => {
      throw Object.assign(new Error("路径非法"), { code: "VALIDATION_ERROR" });
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify([{ skillName: "demo", relativePath: "SKILL.md" }]));
    form.append("files", new File(["# demo"], "SKILL.md", { type: "text/markdown" }));

    const response = await request("/config/skills/upload", { method: "POST", body: form });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await readJson(response))).toContain('"code":"VALIDATION_ERROR"');
  });
});
