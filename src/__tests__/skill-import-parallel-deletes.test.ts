import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { _deps, _resetDeps } from "../services/skill";

const deleteSkillMock = mock(async (_ctx: any, _name: string) => true);
const upsertSkillMock = mock(async () => "skill_1");
const getSkillMock = mock<(_ctx: any, _name: string) => Promise<unknown>>(async () => null);

beforeEach(() => {
  _deps.configPg = {
    deleteSkill: deleteSkillMock,
    upsertSkill: upsertSkillMock,
    getSkill: getSkillMock,
    listSkills: mock(async () => []),
  } as any;
  _deps.skillFs = {
    assertValidSkillName: (name: string) => name.trim(),
    getSkillOrganizationDir: (root: string, organizationId: string) => `${root}/${organizationId}`,
    getSkillSourceDir: (root: string, organizationId: string, name: string) => `${root}/${organizationId}/${name}`,
    getSkillMdPath: (root: string, organizationId: string, name: string) =>
      `${root}/${organizationId}/${name}/SKILL.md`,
    getSkillArchivePath: (root: string, organizationId: string, name: string) =>
      `${root}/${organizationId}/${name}.zip`,
    buildSkillArchive: mock(async () => {}),
    deleteSkillArchive: mock(async () => {}),
    createSkillValidationError: (msg: string) => {
      const e = new Error(msg) as any;
      e.code = "TEST";
      return e;
    },
    groupUploadFiles: (files: { skillName: string; relativePath: string; content: string }[]) => {
      const map = new Map<string, { skillName: string; relativePath: string; content: string }[]>();
      for (const f of files) {
        const arr = map.get(f.skillName) ?? [];
        arr.push(f);
        map.set(f.skillName, arr);
      }
      return map;
    },
    readSkillDetailFromMd: mock(async () => null),
    writeSkillMd: mock(async (_dir: string, _name: string) => "/path/SKILL.md"),
    deleteSkillDir: mock(async () => {}),
    resolveImportPlan: (grouped: Map<string, unknown>, _conflicts: unknown[], _strategy: string | undefined) =>
      ({
        pendingEntries: Array.from(grouped.entries()),
        skipped: [],
      }) as any,
    writeImportFiles: mock(async (_dir: string, entries: [string, unknown][]) => {
      return entries.map(([name]) => name);
    }),
    buildImportedSkillInfos: mock(async (_dir: string, names: string[]) => {
      return names.map((n) => ({ name: n, description: "", path: `/path/${n}/SKILL.md` }));
    }) as any,
    backupSkillDirs: mock(async () => new Map()),
    cleanupWrittenSkills: mock(async () => {}),
    restoreFromBackup: mock(async () => {}),
    createBackupDir: mock(async () => "/tmp/backup"),
    cleanupBackupDir: mock(async () => {}),
  };
});

afterEach(() => {
  _resetDeps();
});

import { importSkillDirectories } from "../services/skill";
import type { UploadSkillFile } from "../services/skill-fs";

describe("importSkillDirectories PG deletes 并行化", () => {
  beforeEach(() => {
    deleteSkillMock.mockClear();
    upsertSkillMock.mockClear();
    getSkillMock.mockClear();
  });

  function makeFile(skillName: string): UploadSkillFile {
    return { skillName, relativePath: "SKILL.md", content: `---\nname: ${skillName}\n---\nContent` };
  }

  test("overwrite 策略下冲突 skill 的 PG delete 应并行执行", async () => {
    getSkillMock.mockImplementation(async (_ctx: any, name: string) => ({
      name,
      organizationId: "test-org",
    }));

    await importSkillDirectories(
      { organizationId: "test-org", userId: "user_1", role: "owner" },
      [makeFile("skill-a"), makeFile("skill-b"), makeFile("skill-c")],
      "overwrite",
    );

    expect(deleteSkillMock).toHaveBeenCalledTimes(3);
    const deletedNames = deleteSkillMock.mock.calls.map((c: unknown[]) => c[1] as string).sort();
    expect(deletedNames).toEqual(["skill-a", "skill-b", "skill-c"]);
  });

  test("无冲突时不应调用 deleteSkill", async () => {
    getSkillMock.mockImplementation(async () => null);

    await importSkillDirectories(
      { organizationId: "test-org", userId: "user_1", role: "owner" },
      [makeFile("new-skill")],
      "overwrite",
    );

    expect(deleteSkillMock).not.toHaveBeenCalled();
    expect(upsertSkillMock).toHaveBeenCalledTimes(1);
  });

  test("rollback 路径下 PG delete 应并行执行（不掩盖原始错误）", async () => {
    const buildMock = _deps.skillFs.buildImportedSkillInfos as ReturnType<typeof mock>;
    buildMock.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    getSkillMock.mockImplementation(async () => null);
    deleteSkillMock.mockImplementation(async () => true);

    await expect(
      importSkillDirectories({ organizationId: "test-org", userId: "user_1", role: "owner" }, [makeFile("fail-skill")]),
    ).rejects.toThrow("disk full");

    expect(deleteSkillMock).toHaveBeenCalledTimes(1);
    expect(deleteSkillMock.mock.calls[0][1]).toBe("fail-skill");
  });

  test("rollback 路径中 deleteSkill 失败不掩盖原始错误", async () => {
    const buildMock = _deps.skillFs.buildImportedSkillInfos as ReturnType<typeof mock>;
    buildMock.mockImplementationOnce(async () => {
      throw new Error("original error");
    });

    getSkillMock.mockImplementation(async () => null);
    deleteSkillMock.mockImplementation(async () => {
      throw new Error("db down");
    });

    await expect(
      importSkillDirectories({ organizationId: "test-org", userId: "user_1", role: "owner" }, [makeFile("fail2")]),
    ).rejects.toThrow("original error");
  });
});
