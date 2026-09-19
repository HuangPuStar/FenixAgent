import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ActorContext } from "@fenix/platform-sdk";
import { ForbiddenError } from "@server/errors";
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
 * `/api/skills` 协议层用例（对外已发布合同）。
 *
 * 关注两点：一是分页与计数由 Facade/数据库完成（协议层不再内存切片），二是 `resourceAccess` 由
 * `toResourceAccessView` 从 `scope + access.actions` 派生——它是唯一保留旧字段形状的位置（决策 D2）。
 */

const apiSkillsRoute = (await import("../server/routes/api/skills")).default;

function authenticate(organizationId = "org-1") {
  setTestAuth({
    user: { id: "user-1", email: "user-1@example.test", name: "Tester" },
    authContext: { organizationId, userId: "user-1", role: "owner" },
  });
  setTestOrgContext({ organizationId, userId: "user-1", role: "owner" });
}

function request(path: string, init?: RequestInit) {
  return apiSkillsRoute.handle(new Request(`http://localhost/api/skills${path}`, init));
}

/** 构造一次合法的上传表单；`overwrite` 是已发布合同里的字符串字面量。 */
function uploadForm(overwrite?: string): FormData {
  const form = new FormData();
  form.set("manifest", JSON.stringify([{ skillName: "demo", relativePath: "SKILL.md" }]));
  if (overwrite !== undefined) form.set("overwrite", overwrite);
  form.append("files", new File(["# demo"], "SKILL.md", { type: "text/markdown" }));
  return form;
}

describe("API Skills Routes", () => {
  beforeEach(() => {
    resetAllStubs();
    resetSkillModuleStub();
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

    expect((await request("/")).status).toBe(401);
  });

  // 分页与计数下推到 Facade：协议层只把 page/pageSize 换算成 limit/offset，不再内存切片。
  test("列表把主体与分页下推给 Facade", async () => {
    let received: { actor?: ActorContext; options?: { limit?: number; offset?: number } } = {};
    installSkillModuleStub({
      facade: {
        list: async (actor, options) => {
          received = { actor, options };
          return { items: [authorizedSkill()], total: 7 };
        },
      },
    });

    const body = await readJson(await request("/?page=2&pageSize=3"));

    expect(body).toMatchObject({ total: 7, page: 2, pageSize: 3 });
    expect(received.actor).toEqual(testActor());
    expect(received.options).toEqual({ limit: 3, offset: 3 });
  });

  // 列表项保留 id 与已发布合同的 resourceAccess 形状；跨组织资源由 scope 派生为 external。
  test("列表把 scope 与 access 映射为 resourceAccess", async () => {
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

    const body = await readJson(await request("/"));

    expect(body.items[0]).toEqual({
      id: "skill-external",
      name: "shared",
      description: "演示技能",
      resourceAccess: {
        ownership: "external",
        sourceOrganizationId: "org-source",
        sourceOrganizationName: "Source Team",
        resourceUid: "skill-external",
        resourceKey: "org-source/skill-external",
        manageable: false,
        writable: false,
        publicReadable: true,
      },
    });
  });

  // 详情按唯一 ID 查询并返回正文；已发布合同不再依赖名称作为对外标识。
  test("详情按 id 读取并返回正文", async () => {
    let receivedId = "";
    installSkillModuleStub({
      facade: {
        readDetailById: async (_actor, resourceId) => {
          receivedId = resourceId;
          return authorizedSkillDetail({ id: "skill-1", content: "# Demo" });
        },
      },
    });

    const body = await readJson(await request("/skill-1"));

    expect(receivedId).toBe("skill-1");
    expect(body).toEqual({
      id: "skill-1",
      name: "demo",
      description: "演示技能",
      content: "# Demo",
      metadata: {},
      resourceAccess: {
        ownership: "internal",
        sourceOrganizationId: "org-1",
        resourceUid: "skill-1",
        resourceKey: "org-1/skill-1",
        manageable: true,
        writable: true,
        publicReadable: false,
      },
    });
  });

  // 不可见与不存在返回同一个 404：区分两者会让资源 ID 成为跨组织探测面。
  test("详情不存在返回 404", async () => {
    installSkillModuleStub({ facade: { readDetailById: async () => undefined } });

    const response = await request("/missing");

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      error: { code: "NOT_FOUND", message: "Skill 'missing' not found" },
    });
  });

  // 上传创建走与 `/web` 一致的 multipart 协议，overwrite=true 映射为覆盖策略，成功后回读详情。
  test("上传创建按 overwrite 传策略并返回详情", async () => {
    let received: { strategy?: string; fileCount?: number } = {};
    installSkillModuleStub({
      facade: {
        importDirectories: async (_actor, files, strategy) => {
          received = { fileCount: files.length, ...(strategy === undefined ? {} : { strategy }) };
          return { imported: [authorizedSkill({ id: "skill-1" })], skipped: [], conflicts: [] };
        },
        readDetailById: async () => authorizedSkillDetail({ id: "skill-1", content: "# Demo" }),
      },
    });

    const response = await request("/", { method: "POST", body: uploadForm("true") });

    expect(response.status).toBe(200);
    expect(received).toEqual({ fileCount: 1, strategy: "overwrite" });
    expect(await readJson(response)).toMatchObject({ id: "skill-1", content: "# Demo" });
  });

  // 未传 overwrite 时不带策略：同名冲突由 Facade 返回冲突清单，协议层映射为 409。
  test("上传命中同名冲突返回 409", async () => {
    installSkillModuleStub({
      facade: {
        importDirectories: async () => ({
          imported: [],
          skipped: [],
          conflicts: [{ name: "demo", enabled: true, path: "/skills/org-1/demo/SKILL.md" }],
        }),
      },
    });

    const response = await request("/", { method: "POST", body: uploadForm() });

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({
      error: { code: "CONFLICT", message: "Skill 'demo' already exists" },
    });
  });

  // 对外接口一次只允许导入一个 Skill：多技能上传是请求错误而不是部分成功。
  test("上传多个技能返回 400", async () => {
    const form = new FormData();
    form.set(
      "manifest",
      JSON.stringify([
        { skillName: "demo", relativePath: "SKILL.md" },
        { skillName: "other", relativePath: "SKILL.md" },
      ]),
    );
    form.append("files", new File(["# demo"], "SKILL.md", { type: "text/markdown" }));
    form.append("files", new File(["# other"], "SKILL.md", { type: "text/markdown" }));

    const response = await request("/", { method: "POST", body: form });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({
      error: { code: "VALIDATION_ERROR", message: "每次只允许导入一个 Skill" },
    });
  });

  // overwrite 只接受 true / false 两个字面量，其余取值是请求错误。
  test("上传 overwrite 取值非法返回 400", async () => {
    const response = await request("/", { method: "POST", body: uploadForm("yes") });

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  // 删除按唯一 ID 删除并把 id 与 name 一起返回，方便调用方回收本地状态。
  test("删除按 id 返回 id 与 name", async () => {
    let removedId = "";
    installSkillModuleStub({
      facade: {
        getById: async () => authorizedSkill({ id: "skill-1" }),
        removeById: async (_actor, resourceId) => {
          removedId = resourceId;
        },
      },
    });

    const response = await request("/skill-1", { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(removedId).toBe("skill-1");
    expect(await readJson(response)).toEqual({ id: "skill-1", name: "demo", deleted: true });
  });

  // 不可见或不存在时不调用删除：先读后删，读不到即 404，不伪造幂等成功。
  test("删除不存在技能返回 404 且不调用删除", async () => {
    let removed = false;
    installSkillModuleStub({
      facade: {
        getById: async () => undefined,
        removeById: async () => {
          removed = true;
        },
      },
    });

    const response = await request("/missing", { method: "DELETE" });

    expect(response.status).toBe(404);
    expect(removed).toBeFalse();
  });

  // 可读但未获删除动作时，Facade 的拒绝必须按 403 原样映射，不能被降级成 404 或 500。
  test("删除未获删除动作返回 403", async () => {
    installSkillModuleStub({
      facade: {
        getById: async () => authorizedSkill({ actions: ["read"] }),
        removeById: async () => {
          throw new ForbiddenError("当前主体无权执行资源动作");
        },
      },
    });

    const response = await request("/skill-1", { method: "DELETE" });

    expect(response.status).toBe(403);
    expect(await readJson(response)).toEqual({
      error: { code: "FORBIDDEN", message: "当前主体无权执行资源动作" },
    });
  });
});
