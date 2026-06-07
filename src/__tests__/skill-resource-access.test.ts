import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setConfig } from "../config";
import { AppError } from "../errors";
import type { ResourceAccess, SkillConfigRowWithAccess } from "../services/config/types";
import { _deps, _resetDeps, deleteSkill, getSkill, listSkills, setSkill } from "../services/skill";

const ctx = { organizationId: "org-current", userId: "user-owner", role: "owner" } as const;
const root = "/tmp/rcs-skills";

const internalAccess: ResourceAccess = {
  ownership: "internal",
  sourceOrganizationId: "org-current",
  resourceUid: "skill-internal",
  resourceKey: "org-current/skill-internal",
  manageable: true,
  writable: true,
  publicReadable: false,
};

const externalAccess: ResourceAccess = {
  ownership: "external",
  sourceOrganizationId: "org-source",
  resourceUid: "skill-external",
  resourceKey: "org-source/skill-external",
  manageable: false,
  writable: false,
};

function skillMeta(overrides: Record<string, unknown> = {}) {
  return {
    id: "skill-internal",
    userId: "user-owner",
    organizationId: "org-current",
    name: "demo",
    description: "Demo",
    metadata: {},
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    resourceAccess: internalAccess,
    ...overrides,
  };
}

function installMocks() {
  const configPg = {
    getSkill: mock(async (): Promise<SkillConfigRowWithAccess | null> => null),
    getSkillByResourceKey: mock(async (): Promise<SkillConfigRowWithAccess | null> => null),
    upsertSkill: mock(async () => "skill-internal"),
    deleteSkill: mock(async () => true),
    listSkills: mock(async (): Promise<SkillConfigRowWithAccess[]> => []),
  };
  const skillFs = {
    assertValidSkillName: (name: string) => {
      if (name.includes("/")) throw new Error("resource key should not be validated as skill name");
      return name.trim();
    },
    getSkillOrganizationDir: (skillRoot: string, organizationId: string) => `${skillRoot}/${organizationId}`,
    getSkillSourceDir: (skillRoot: string, organizationId: string, name: string) =>
      `${skillRoot}/${organizationId}/${name}`,
    getSkillMdPath: (skillRoot: string, organizationId: string, name: string) =>
      `${skillRoot}/${organizationId}/${name}/SKILL.md`,
    getSkillArchivePath: (skillRoot: string, organizationId: string, name: string) =>
      `${skillRoot}/${organizationId}/${name}.zip`,
    buildSkillArchive: mock(async () => {}),
    deleteSkillArchive: mock(async () => {}),
    createSkillValidationError: (msg: string) => {
      const e = new Error(msg) as Error & { code: string };
      e.code = "TEST";
      return e;
    },
    readSkillDetailFromMd: mock(async () => ({
      content: "# Demo",
      metadata: { description: "From file", extra: "yes" },
    })),
    writeSkillMd: mock(async (dir: string) => `${dir}/SKILL.md`),
    deleteSkillDir: mock(async () => {}),
    backupSkillDirs: mock(async () => new Map()),
    cleanupWrittenSkills: mock(async () => {}),
    restoreFromBackup: mock(async () => {}),
    createBackupDir: mock(async () => "/tmp/backup"),
    cleanupBackupDir: mock(async () => {}),
    groupUploadFiles: mock(() => new Map()),
    resolveImportPlan: mock(() => ({ pendingEntries: [], skipped: [] })),
    writeImportFiles: mock(async () => []),
    buildImportedSkillInfos: mock(async () => []),
  };

  _deps.configPg = configPg as never;
  _deps.skillFs = skillFs as never;
  return { configPg, skillFs };
}

beforeEach(() => {
  setConfig({ skillDir: root });
});

afterEach(() => {
  _resetDeps();
});

describe("skill resource access orchestration", () => {
  // listSkills 透传内部和外部 resourceAccess，外部路径按源组织推导。
  test("listSkills 透传 resourceAccess", async () => {
    const { configPg } = installMocks();
    configPg.listSkills.mockImplementationOnce(async () => [
      skillMeta({ id: "skill-internal", resourceAccess: internalAccess }),
      skillMeta({
        id: "skill-external",
        organizationId: "org-source",
        resourceAccess: externalAccess,
      }),
    ]);

    const rows = await listSkills(ctx);

    expect(rows.map((row) => row.resourceAccess?.resourceKey)).toEqual([
      "org-current/skill-internal",
      "org-source/skill-external",
    ]);
    expect(rows[1].path).toBe(`${root}/org-source/demo/SKILL.md`);
  });

  // getSkill(resourceKey) 通过源组织推导 SKILL.md 路径。
  test("getSkill 支持 resourceKey 并读取源路径", async () => {
    const { configPg, skillFs } = installMocks();
    configPg.getSkillByResourceKey.mockImplementationOnce(async () =>
      skillMeta({
        id: "skill-external",
        organizationId: "org-source",
        resourceAccess: externalAccess,
      }),
    );

    const detail = await getSkill(ctx, "org-source/skill-external");

    expect(configPg.getSkillByResourceKey).toHaveBeenCalledWith(ctx, "org-source/skill-external");
    expect(skillFs.readSkillDetailFromMd).toHaveBeenCalledWith(`${root}/org-source/demo/SKILL.md`);
    expect(detail?.resourceAccess?.writable).toBe(false);
  });

  // setSkill 把 publicReadable 作为 options 传给 config service。
  test("setSkill 透传 publicReadable", async () => {
    const { configPg } = installMocks();
    configPg.getSkill.mockImplementationOnce(async () =>
      skillMeta({ resourceAccess: { ...internalAccess, publicReadable: true } }),
    );

    await setSkill(ctx, "demo", { description: "Demo", content: "# Demo", publicReadable: true });

    expect(configPg.upsertSkill).toHaveBeenCalledWith(
      ctx,
      "demo",
      { description: "Demo", metadata: undefined },
      { publicReadable: true },
    );
  });

  // deleteSkill 对外部只读资源抛 403，且不删除文件。
  test("deleteSkill 拒绝外部只读资源", async () => {
    const { configPg, skillFs } = installMocks();
    configPg.getSkill.mockImplementationOnce(async () =>
      skillMeta({ id: "skill-external", organizationId: "org-source", resourceAccess: externalAccess }),
    );

    await expect(deleteSkill(ctx, "demo")).rejects.toThrow(AppError);
    expect(configPg.deleteSkill).not.toHaveBeenCalled();
    expect(skillFs.deleteSkillDir).not.toHaveBeenCalled();
  });
});
