import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStubAgentAssociations,
  createStubAgentConfigFacade,
  createStubAgentConfigServerModule,
  installAgentConfigModule,
  resetAgentConfigModuleForTesting,
} from "@fenix/agent-config/server/testing";
import {
  createStubModelManagementServerModule,
  createStubProviderFacade,
  installModelManagementModule,
  resetModelManagementModuleForTesting,
} from "@fenix/model-management/server/testing";
import { ForbiddenError, NotFoundError } from "@fenix/platform-sdk";
import { resetAllStubs, stubDb, stubModuleConfig } from "@fenix/platform-sdk/testing";
import {
  createStubSkillFacade,
  createStubSkillServerModule,
  installSkillServerModule,
  resetSkillServerModuleForTesting,
} from "@fenix/resource-skill/server/testing";
import { setConfig } from "../config";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { stubConfigPg } from "../test-utils/stubs/config-pg-stub";

const configRoute = (await import("../routes/web/config/index")).createWebConfigApp([]);

function request(path: string, init?: RequestInit) {
  return configRoute.handle(new Request(`http://localhost${path.replace(/^\/web/, "")}`, init));
}

/**
 * 外部组织共享的 Agent 资源视图（授权栈产出的 `scope + access` 形状）。
 *
 * 归属列不再由配置服务聚合，而是资源模块的 Facade 产出；用例直接构造该形状，断言协议层把它原样
 * 映射进 `/web` 视图（决策 D2：`/web` 不再返回旧栈的 `resourceAccess`）。
 */
interface SharedAgentOverrides {
  readonly prompt?: string | null;
  readonly machineId?: string | null;
  readonly agentNode?: unknown;
}

function sharedAgent(overrides: SharedAgentOverrides = {}) {
  const organizationId = "org-source";
  const ownerUserId = "user-source";
  return {
    id: "agc-external",
    userId: ownerUserId,
    organizationId,
    name: "shared-agent",
    model: "provider/model",
    modelId: null,
    prompt: overrides.prompt ?? null,
    description: "shared",
    extra: null,
    agentNode: overrides.agentNode ?? {},
    machineId: overrides.machineId ?? null,
    engineType: null,
    visibility: "public" as const,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    scope: { organizationId, ownerUserId, visibility: "public" as const },
    access: { actions: ["read" as const] },
  };
}

/**
 * 关联资源标签投影会按绑定 ID 查展示表：这里让查询统一返回空行，标签因此退化为 ID 兜底。
 *
 * 链式替身必须同时支持 `await query` 与 `.limit(1)` 两种收尾方式（`agent-related-resources` 两者都用）。
 */
function installEmptyRelatedResourceDb() {
  stubDb({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
          // biome-ignore lint/suspicious/noThenProperty: Drizzle 查询构造器在 await 时必须是 thenable。
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
        }),
      }),
    }),
  });
}

function readCentralDirectoryNames(zip: Buffer): string[] {
  const endOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(endOffset).toBeGreaterThanOrEqual(0);
  const count = zip.readUInt16LE(endOffset + 10);
  let offset = zip.readUInt32LE(endOffset + 16);
  const names: string[] = [];

  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf-8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

describe("Config Route Integration", () => {
  let tempSkillDir = "";

  beforeEach(() => {
    resetAllStubs();
    // Agent 授权与资源解析已整体收敛到资源模块：装入替身，用例只声明"应用层返回什么"。
    installAgentConfigModule(
      createStubAgentConfigServerModule({
        facade: createStubAgentConfigFacade({
          list: async () => ({ items: [], total: 0 }),
          get: async () => undefined,
        }),
      }),
    );
    installSkillServerModule(createStubSkillServerModule());
    // Provider / Model 的授权与编排同样收敛到资源模块，列表用例只声明"应用层返回什么"。
    installModelManagementModule(
      createStubModelManagementServerModule({
        facade: createStubProviderFacade({ list: async () => ({ items: [], total: 0 }) }),
      }),
    );
    tempSkillDir = join(tmpdir(), `fenix-config-skill-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempSkillDir, { recursive: true });
    setConfig({ baseUrl: "http://rcs.test", skillDir: tempSkillDir });
    // Skill 路由改经 `getModuleConfig("skill")` 读内容目录与对外地址（CE 阶段 2 任务 1.3 的注入端口），
    // 用例必须把本用例的临时目录登记到模块配置层：`setConfig()` 只改宿主 config，路由已不读它，
    // 不登记就会去 `./data/skills` 找归档（下载类用例报 ENOENT → 404）。
    stubModuleConfig("skill", { skillDir: tempSkillDir, baseUrl: "http://rcs.test" });
    process.env.RCS_API_KEYS = "test-key";
    stubDb({
      select: () => ({
        from: () => ({ where: async () => [] }),
      }),
    });
    stubConfigPg({
      // provider / model 的配置面已随任务 1.2 迁入 `@fenix/model-management`；用户级配置读写在任务 1.5c
      // 随 `user_config` 表归位 identity（键名与用例写法不变，安装点见 setup-mocks.ts）。
      getUserConfig: async () => ({ defaultAgent: null, currentModel: null, smallModel: null, permission: null }),
      setUserConfig: async () => {},
    });
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: { organizationId: "test-team", userId: "test-user", role: "owner" },
    });
    setTestOrgContext({ organizationId: "test-team", userId: "test-user", role: "owner" });
  });

  afterEach(() => {
    resetAgentConfigModuleForTesting();
    resetSkillServerModuleForTesting();
    resetModelManagementModuleForTesting();
    resetTestAuth();
    setTestOrgContext(null);
    if (tempSkillDir) {
      rmSync(tempSkillDir, { recursive: true, force: true });
    }
  });

  test("mocked sessionAuth 通过后返回成功", async () => {
    const res = await request("/web/config/providers", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  test("无效 module 返回 404", async () => {
    const res = await request("/web/config/invalid", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  test("providers 路由可达", async () => {
    const res = await request("/web/config/providers", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).not.toBe(404);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  test("models 路由可达", async () => {
    const res = await request("/web/config/models", {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).not.toBe(404);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  test("agents 路由可达", async () => {
    const res = await request("/web/config/agents", {
      method: "GET",
    });
    expect(res.status).not.toBe(404);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  // Agent 配置页面使用的 Sandbox Pool 查询接口应挂载在同一 Web Config 路由下。
  test("sandbox pools 路由可达", async () => {
    const res = await request("/web/config/sandbox-pools", { method: "GET" });
    expect(res.status).not.toBe(404);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ enabled: false, pools: [] });
  });

  // 列表返回的是资源归属范围与当前主体有效动作（决策 D2），不再有旧栈的 resourceAccess。
  test("agents list 返回共享 Agent 的 scope 与有效动作", async () => {
    installEmptyRelatedResourceDb();
    installAgentConfigModule(
      createStubAgentConfigServerModule({
        facade: createStubAgentConfigFacade({
          list: async () => ({ items: [sharedAgent()], total: 1 }),
        }),
        associations: createStubAgentAssociations({ listSkillIds: async () => ["skill-1"] }),
      }),
    );

    const res = await request("/web/config/agents", {
      method: "GET",
    });
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.agents[0].scope).toEqual({
      organizationId: "org-source",
      ownerUserId: "user-source",
      visibility: "public",
    });
    expect(json.data.agents[0].access).toEqual({ actions: ["read"] });
    expect(json.data.agents[0].model).toBe("provider/model");
    expect(json.data.agents[0].modelLabel).toBe(null);
    expect(json.data.agents[0].skillLabels).toEqual([{ id: "skill-1", label: "skill-1" }]);
  });

  // 详情同样返回归属范围与有效动作，并保留执行节点投影。
  test("agents get 可读取外部共享 Agent 详情", async () => {
    installEmptyRelatedResourceDb();
    installAgentConfigModule(
      createStubAgentConfigServerModule({
        facade: createStubAgentConfigFacade({
          get: async () =>
            sharedAgent({
              prompt: "shared prompt",
              machineId: "machine-1",
              agentNode: { kind: "machine", machineId: "machine-1" },
            }),
        }),
        associations: createStubAgentAssociations({ listSkillIds: async () => ["skill-1"] }),
      }),
    );

    const res = await request("/web/config/agents?name=org-source%2Fagc-external", { method: "GET" });
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.scope).toEqual({
      organizationId: "org-source",
      ownerUserId: "user-source",
      visibility: "public",
    });
    expect(json.data.access).toEqual({ actions: ["read"] });
    expect(json.data.agentNode).toEqual({ kind: "machine", machineId: "machine-1" });
  });

  // 缺少 name 查询参数在协议层就被拒绝，不得进入应用层。
  test("agents set 缺少 name 时返回校验错误", async () => {
    const res = await request("/web/config/agents", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { prompt: "x" } }),
    });
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  // 共享只读 Agent 的写入拒绝由 Facade 抛出宿主错误，路由映射为 403。
  test("agents set 拒绝修改外部共享 Agent", async () => {
    installAgentConfigModule(
      createStubAgentConfigServerModule({
        facade: createStubAgentConfigFacade({
          update: async () => {
            throw new ForbiddenError("只读共享资源");
          },
        }),
      }),
    );

    const res = await request("/web/config/agents?name=org-source%2Fagc-external", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { prompt: "x" } }),
    });
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(json.error.code).toBe("FORBIDDEN");
  });

  // 列表路由只依赖 Facade 的授权结果，装配替身即可验证路由可达且走通 /web 响应包装。
  test("skills GET 路由可达", async () => {
    installSkillServerModule(
      createStubSkillServerModule({
        facade: createStubSkillFacade({ list: async () => ({ items: [], total: 0 }) }),
      }),
    );
    const res = await request("/web/config/skills", {
      method: "GET",
    });
    expect(res.status).not.toBe(404);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  // 查不到详情的 Skill：Facade 的 undefined 必须映射为 /web 的 404，而不是 500。
  test("skills GET by name 返回 404", async () => {
    installSkillServerModule(
      createStubSkillServerModule({
        facade: createStubSkillFacade({ readDetail: async () => undefined }),
      }),
    );
    const res = await request("/web/config/skills/nonexistent", {
      method: "GET",
    });
    expect(res.status).toBe(404);
  });

  // 删除不可见/不存在的 Skill：Facade 抛 NOT_FOUND，路由映射为 404。
  test("skills DELETE 返回 404", async () => {
    installSkillServerModule(
      createStubSkillServerModule({
        facade: createStubSkillFacade({
          remove: async () => {
            throw new NotFoundError("Skill 'nonexistent' not found");
          },
        }),
      }),
    );
    const res = await request("/web/config/skills/nonexistent", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  // 下载归档按归属组织目录重建 zip，并保证顶层目录为 Skill 名称而非绝对路径。
  test("skills download 返回带根目录的受保护 zip 文件流", async () => {
    installSkillServerModule(
      createStubSkillServerModule({
        facade: createStubSkillFacade({
          get: async () => ({
            id: "skill-1",
            name: "demo",
            description: "demo",
            path: join(tempSkillDir, "test-team", "demo", "SKILL.md"),
            scope: { organizationId: "test-team", ownerUserId: "test-user", visibility: "private" },
            access: { actions: ["read", "update", "delete"] },
          }),
        }),
      }),
    );
    mkdirSync(join(tempSkillDir, "test-team", "demo", "references"), { recursive: true });
    writeFileSync(join(tempSkillDir, "test-team", "demo", "SKILL.md"), "# Demo");
    writeFileSync(join(tempSkillDir, "test-team", "demo", "references", "ref.md"), "ref");

    const res = await request("/web/config/skills/demo/download", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="demo.zip"');
    const names = readCentralDirectoryNames(Buffer.from(await res.arrayBuffer()));
    expect(names).toEqual(["demo/SKILL.md", "demo/references/ref.md"]);
  });

  // 跨组织公开的 Skill 也从归属组织目录取归档，资源键路径参数需先解码再定位。
  test("skills download 支持共享 skill resourceKey 并保留根目录", async () => {
    installSkillServerModule(
      createStubSkillServerModule({
        facade: createStubSkillFacade({
          get: async () => ({
            id: "skill-external",
            name: "shared-skill",
            description: "shared",
            path: join(tempSkillDir, "org-source", "shared-skill", "SKILL.md"),
            scope: { organizationId: "org-source", ownerUserId: "user-source", visibility: "public" },
            access: { actions: ["read"] },
          }),
        }),
      }),
    );
    mkdirSync(join(tempSkillDir, "org-source", "shared-skill", "references"), { recursive: true });
    writeFileSync(join(tempSkillDir, "org-source", "shared-skill", "SKILL.md"), "# Shared");
    writeFileSync(join(tempSkillDir, "org-source", "shared-skill", "references", "guide.md"), "guide");

    const res = await request("/web/config/skills/org-source%2Fskill-external/download", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="shared-skill.zip"');
    const names = readCentralDirectoryNames(Buffer.from(await res.arrayBuffer()));
    expect(names).toEqual(["shared-skill/SKILL.md", "shared-skill/references/guide.md"]);
  });
});
