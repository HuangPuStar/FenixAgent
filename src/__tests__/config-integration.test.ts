import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../config";
import { AppError } from "../errors";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setListAgentKnowledgeBindingsById } from "../services/agent-knowledge";
import { setTestOrgContext } from "../services/org-context";
import { _deps, _resetDeps } from "../services/skill";
import { resetAllStubs, stubConfigPg, stubDb } from "../test-utils/helpers";

const configRoute = (await import("../routes/web/config/index")).default;

function request(path: string, init?: RequestInit) {
  return configRoute.handle(new Request(`http://localhost${path.replace(/^\/web/, "")}`, init));
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
    _resetDeps();
    setListAgentKnowledgeBindingsById(async () => []);
    tempSkillDir = join(tmpdir(), `fenix-config-skill-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tempSkillDir, { recursive: true });
    setConfig({ baseUrl: "http://rcs.test", skillDir: tempSkillDir });
    process.env.RCS_API_KEYS = "test-key";
    stubConfigPg({
      listProviders: async () => [],
      getProvider: async () => null,
      upsertProvider: async () => "prov-id",
      deleteProvider: async () => true,
      addModel: async () => {},
      updateModel: async () => {},
      removeModel: async () => {},
      getUserConfig: async () => ({ defaultAgent: null, currentModel: null, smallModel: null, permission: null }),
      setUserConfig: async () => {},
      listAgentConfigs: async () => [],
      getAgentConfig: async () => null,
      getAgentConfigByResourceKey: async () => null,
      getReadableAgentConfigById: async () => null,
      assertAgentConfigInternalWritable: async () => null,
      createAgentConfig: async () => {},
      updateAgentConfig: async () => {},
      deleteAgentConfig: async () => [],
      listMcpServers: async () => [],
      getMcpServer: async () => null,
      createMcpServer: async () => {},
      updateMcpServer: async () => {},
      deleteMcpServer: async () => [],
      setMcpServerEnabled: async () => [],
      listSkills: async () => [],
      getSkill: async () => null,
      upsertSkill: async () => "skill-id",
      deleteSkill: async () => true,
      listAgentSkillIds: async () => [],
      listAgentMcpIds: async () => [],
      syncAgentSkills: async () => {},
      syncAgentMcps: async () => {},
    });
    _deps.skillFs.readSkillDetailFromMd = async () => ({
      name: "demo",
      description: "demo",
      content: "# demo",
      enabled: true,
      path: "/tmp/demo/SKILL.md",
      metadata: {},
    });
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: { organizationId: "test-team", userId: "test-user", role: "owner" },
    });
    setTestOrgContext({ organizationId: "test-team", userId: "test-user", role: "owner" });
  });

  afterEach(() => {
    setListAgentKnowledgeBindingsById(null);
    _resetDeps();
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

  test("agents list 返回共享 Agent 的 resourceAccess", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: async () => [],
          limit: async () => [],
        }),
      }),
    });
    stubConfigPg({
      listAgentConfigs: async () => [
        {
          id: "agc-external",
          userId: "user-source",
          organizationId: "org-source",
          name: "shared-agent",
          model: "provider/model",
          modelId: null,
          mode: "primary",
          description: "shared",
          color: null,
          machineId: null,
          resourceAccess: {
            ownership: "external",
            sourceOrganizationId: "org-source",
            sourceOrganizationName: "Source Team",
            resourceUid: "agc-external",
            resourceKey: "org-source/agc-external",
            manageable: false,
            writable: false,
          },
        },
      ],
      listAgentSkillIds: async () => ["skill-1"],
      listAgentMcpIds: async () => [],
      listAgentSiteAppIds: async () => [],
    });

    const res = await request("/web/config/agents", {
      method: "GET",
    });
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.agents[0].resourceAccess.resourceKey).toBe("org-source/agc-external");
    expect(json.data.agents[0].resourceAccess.ownership).toBe("external");
    expect(json.data.agents[0].model).toBe("provider/model");
    expect(json.data.agents[0].modelLabel).toBe(null);
    expect(json.data.agents[0].skillLabels).toEqual([{ id: "skill-1", label: "skill-1" }]);
  });

  test("agents get 可读取外部共享 Agent 详情", async () => {
    stubConfigPg({
      getAgentConfig: async () => ({
        id: "agc-external",
        userId: "user-source",
        organizationId: "org-source",
        name: "shared-agent",
        model: "provider/model",
        modelId: null,
        prompt: "shared prompt",
        steps: 20,
        mode: "primary",
        permission: null,
        variant: null,
        temperature: null,
        topP: null,
        disable: false,
        hidden: false,
        color: null,
        description: "shared",
        knowledge: null,
        machineId: "machine-1",
        resourceAccess: {
          ownership: "external",
          sourceOrganizationId: "org-source",
          sourceOrganizationName: "Source Team",
          resourceUid: "agc-external",
          resourceKey: "org-source/agc-external",
          manageable: false,
          writable: false,
        },
      }),
      listAgentSkillIds: async () => ["skill-1"],
      listAgentMcpIds: async () => [],
      listAgentSiteAppIds: async () => [],
    });
    stubDb({
      select: () => {
        const chainable = {
          where: () => chainable,
          limit: () => chainable,
          // biome-ignore lint/suspicious/noThenProperty: 链式查询 mock 需要 thenable 支持 await
          then: (resolve: (v: unknown[]) => void) => resolve([]),
        };
        return { from: () => chainable };
      },
    });

    const res = await request("/web/config/agents?name=org-source%2Fagc-external", { method: "GET" });
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.resourceAccess.resourceKey).toBe("org-source/agc-external");
    expect(json.data.machineId).toBe("machine-1");
  });

  test("agents set 缺少 name 时返回校验错误", async () => {
    stubConfigPg({
      assertAgentConfigInternalWritable: async () => {
        throw new AppError("forbidden", "FORBIDDEN", 403);
      },
    });

    const res = await request("/web/config/agents", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { prompt: "x" } }),
    });
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  test("agents set 拒绝修改外部共享 Agent", async () => {
    stubConfigPg({
      assertAgentConfigInternalWritable: async () => {
        throw new AppError("forbidden", "FORBIDDEN", 403);
      },
    });

    const res = await request("/web/config/agents?name=org-source%2Fagc-external", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { prompt: "x" } }),
    });
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(json.error.code).toBe("FORBIDDEN");
  });

  test("skills GET 路由可达", async () => {
    const res = await request("/web/config/skills", {
      method: "GET",
    });
    expect(res.status).not.toBe(404);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  test("skills GET by name 返回 404", async () => {
    const res = await request("/web/config/skills/nonexistent", {
      method: "GET",
    });
    expect(res.status).toBe(404);
  });

  test("skills DELETE 返回 404", async () => {
    const res = await request("/web/config/skills/nonexistent", {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  test("skills download 返回带根目录的受保护 zip 文件流", async () => {
    stubConfigPg({
      getSkill: async () => ({
        id: "skill-1",
        userId: "test-user",
        organizationId: "test-team",
        name: "demo",
        description: "demo",
        metadata: {},
        resourceAccess: {
          ownership: "internal",
          sourceOrganizationId: "test-team",
          resourceUid: "skill-1",
          resourceKey: "test-team/skill-1",
          manageable: true,
          writable: true,
          publicReadable: false,
        },
      }),
    });
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

  test("skills download 支持共享 skill resourceKey 并保留根目录", async () => {
    stubConfigPg({
      getSkillByResourceKey: async () => ({
        id: "skill-external",
        userId: "user-source",
        organizationId: "org-source",
        name: "shared-skill",
        description: "shared",
        metadata: {},
        resourceAccess: {
          ownership: "external",
          sourceOrganizationId: "org-source",
          sourceOrganizationName: "Source Team",
          resourceUid: "skill-external",
          resourceKey: "org-source/skill-external",
          manageable: false,
          writable: false,
        },
      }),
    });
    _deps.skillFs.readSkillDetailFromMd = async () => ({
      name: "shared-skill",
      description: "shared",
      content: "# shared",
      enabled: true,
      path: "/tmp/shared/SKILL.md",
      metadata: {},
    });
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
