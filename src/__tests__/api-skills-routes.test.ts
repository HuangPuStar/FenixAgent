import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { _deps, _resetDeps } from "../services/skill";
import type {
  ConflictCheckResult,
  ImportConflictStrategy,
  ImportSkillsConflict,
  UploadSkillFile,
} from "../services/skill-fs";
import { resetAllStubs, stubConfigPg } from "../test-utils/helpers";

const apiSkillsRoute = (await import("../routes/api/skills")).default;

function request(path: string, init?: RequestInit) {
  return apiSkillsRoute.handle(new Request(`http://localhost${path}`, init));
}

describe("API Skills Routes", () => {
  beforeEach(() => {
    resetAllStubs();
    _resetDeps();
    setTestAuth({
      user: { id: "user-1", email: "user@test.com", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    setTestOrgContext({ organizationId: "org-1", userId: "user-1", role: "owner" });
    stubConfigPg({
      deleteSkill: async () => true,
      deleteSkillById: async () => true,
      getSkill: async () => null,
      getSkillById: async () => null,
      getSkillByResourceKey: async () => null,
      listSkills: async () => [],
      upsertSkill: async () => "skill-1",
    });
    _deps.skillFs.readSkillDetailFromMd = mock(async () => null);
    _deps.skillFs.deleteSkillDir = mock(async () => undefined);
    _deps.skillFs.deleteSkillArchive = mock(async () => undefined);
    _deps.skillFs.groupUploadFiles = mock((files) => {
      const grouped = new Map<string, Array<(typeof files)[number]>>();
      for (const file of files) {
        const current = grouped.get(file.skillName) ?? [];
        current.push(file);
        grouped.set(file.skillName, current);
      }
      return grouped;
    });
    _deps.skillFs.resolveImportPlan = mock(
      (
        grouped: Map<string, UploadSkillFile[]>,
        _conflicts: ImportSkillsConflict[],
        _strategy?: ImportConflictStrategy,
      ): ConflictCheckResult => ({
        pendingEntries: Array.from(grouped.entries()),
        skipped: [],
      }),
    );
    _deps.skillFs.createBackupDir = mock(async () => "/tmp/backup");
    _deps.skillFs.backupSkillDirs = mock(async () => new Map());
    _deps.skillFs.cleanupWrittenSkills = mock(async () => undefined);
    _deps.skillFs.writeImportFiles = mock(async (_targetDir: string, pendingEntries: [string, UploadSkillFile[]][]) =>
      pendingEntries.map(([name]) => name),
    );
    _deps.skillFs.buildImportedSkillInfos = mock(async () => [
      { id: "skill-1", name: "demo", enabled: true, description: "Demo skill", path: "/tmp/demo/SKILL.md" },
    ]);
    _deps.skillFs.buildSkillArchive = mock(async () => undefined);
    _deps.skillFs.restoreFromBackup = mock(async () => undefined);
    _deps.skillFs.cleanupBackupDir = mock(async () => undefined);
  });

  afterEach(() => {
    _resetDeps();
    resetTestAuth();
    setTestOrgContext(null);
  });

  // Skill 列表接口应返回显式 id，避免调用方只能从 resourceAccess 反推 uid。
  test("GET /api/skills returns paginated list with id", async () => {
    stubConfigPg({
      listSkills: async () => [
        {
          id: "skill-1",
          name: "demo",
          description: "Demo skill",
          metadata: null,
          organizationId: "org-1",
          userId: "user-1",
          createdAt: new Date(),
          updatedAt: new Date(),
          resourceAccess: {
            ownership: "internal",
            sourceOrganizationId: "org-1",
            resourceUid: "skill-1",
            resourceKey: "org-1/skill-1",
            manageable: true,
            writable: true,
            publicReadable: false,
          },
        } as never,
      ],
    });

    const res = await request("/api/skills?page=1&pageSize=10");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      items: [
        {
          id: "skill-1",
          name: "demo",
          description: "Demo skill",
          resourceAccess: {
            ownership: "internal",
            sourceOrganizationId: "org-1",
            resourceUid: "skill-1",
            resourceKey: "org-1/skill-1",
            manageable: true,
            writable: true,
            publicReadable: false,
          },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
  });

  // Skill 详情接口应按 id 查询，而不是继续依赖 name 作为对外标识。
  test("GET /api/skills/:id returns detail by id", async () => {
    stubConfigPg({
      getSkillById: async () =>
        ({
          id: "skill-1",
          name: "demo",
          description: "Demo skill",
          metadata: null,
          organizationId: "org-1",
          userId: "user-1",
          createdAt: new Date(),
          updatedAt: new Date(),
          resourceAccess: {
            ownership: "internal",
            sourceOrganizationId: "org-1",
            resourceUid: "skill-1",
            resourceKey: "org-1/skill-1",
            manageable: true,
            writable: true,
            publicReadable: false,
          },
        }) as never,
    });
    _deps.skillFs.readSkillDetailFromMd = mock(async () => ({
      metadata: { source: "test", description: "ignored" },
      content: "# Demo",
    }));

    const res = await request("/api/skills/skill-1");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      id: "skill-1",
      name: "demo",
      description: "Demo skill",
      content: "# Demo",
      metadata: { source: "test" },
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

  // Skill 创建接口应走 multipart 上传导入链路，并支持 overwrite=true。
  test("POST /api/skills imports one skill from multipart upload", async () => {
    stubConfigPg({
      getSkill: async () => null,
      upsertSkill: async () => "skill-1",
      listSkills: async () => [
        {
          id: "skill-1",
          name: "demo",
          description: "Demo skill",
          metadata: null,
          organizationId: "org-1",
          userId: "user-1",
          createdAt: new Date(),
          updatedAt: new Date(),
          resourceAccess: {
            ownership: "internal",
            sourceOrganizationId: "org-1",
            resourceUid: "skill-1",
            resourceKey: "org-1/skill-1",
            manageable: true,
            writable: true,
            publicReadable: false,
          },
        } as never,
      ],
      getSkillById: async () =>
        ({
          id: "skill-1",
          name: "demo",
          description: "Demo skill",
          metadata: null,
          organizationId: "org-1",
          userId: "user-1",
          createdAt: new Date(),
          updatedAt: new Date(),
          resourceAccess: {
            ownership: "internal",
            sourceOrganizationId: "org-1",
            resourceUid: "skill-1",
            resourceKey: "org-1/skill-1",
            manageable: true,
            writable: true,
            publicReadable: false,
          },
        }) as never,
    });
    _deps.skillFs.readSkillDetailFromMd = mock(async () => ({
      metadata: { source: "upload" },
      content: "# Demo",
    }));

    const form = new FormData();
    form.set("manifest", JSON.stringify([{ skillName: "demo", relativePath: "SKILL.md" }]));
    form.set("overwrite", "true");
    form.append("files", new File(["# Demo"], "SKILL.md", { type: "text/markdown" }));

    const res = await request("/api/skills/", {
      method: "POST",
      body: form,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      id: "skill-1",
      name: "demo",
      description: "Demo skill",
      content: "# Demo",
      metadata: { source: "upload" },
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

  // Skill 删除接口应按 id 删除，并把 id 与 name 一起返回，方便调用方回收本地状态。
  test("DELETE /api/skills/:id returns deleted id and name", async () => {
    stubConfigPg({
      getSkillById: async () =>
        ({
          id: "skill-1",
          name: "demo",
          description: "Demo skill",
          metadata: null,
          organizationId: "org-1",
          userId: "user-1",
          createdAt: new Date(),
          updatedAt: new Date(),
          resourceAccess: {
            ownership: "internal",
            sourceOrganizationId: "org-1",
            resourceUid: "skill-1",
            resourceKey: "org-1/skill-1",
            manageable: true,
            writable: true,
            publicReadable: false,
          },
        }) as never,
      deleteSkillById: async () => true,
    });

    const res = await request("/api/skills/skill-1", {
      method: "DELETE",
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      id: "skill-1",
      name: "demo",
      deleted: true,
    });
  });
});
