import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setConfig } from "../config";
import { _deps, _resetDeps, deleteSkill, importSkillDirectories, setSkill } from "../services/skill";
import type { UploadSkillFile } from "../services/skill-fs";

const ctx = { organizationId: "org-1", userId: "user-1", role: "owner" } as const;
const root = "/tmp/rcs-skills";

function makeFile(name: string): UploadSkillFile {
  return { skillName: name, relativePath: "SKILL.md", content: `---\nname: ${name}\n---\nBody` };
}

function installMocks() {
  const configPg = {
    getSkill: mock(async () => null),
    upsertSkill: mock(async () => "skill-id"),
    deleteSkill: mock(async () => true),
    listSkills: mock(async () => []),
  };
  const skillFs = {
    assertValidSkillName: (name: string) => name.trim(),
    getSkillSourceDir: (skillRoot: string, name: string) => `${skillRoot}/${name}`,
    getSkillArchivePath: (skillRoot: string, name: string) => `${skillRoot}/${name}.zip`,
    buildSkillArchive: mock(async () => {}),
    deleteSkillArchive: mock(async () => {}),
    createSkillValidationError: (msg: string) => {
      const e = new Error(msg) as Error & { code: string };
      e.code = "TEST";
      return e;
    },
    groupUploadFiles: (files: UploadSkillFile[]) => {
      const grouped = new Map<string, UploadSkillFile[]>();
      for (const file of files) {
        const skillName = file.skillName.trim();
        grouped.set(skillName, [...(grouped.get(skillName) ?? []), { ...file, skillName }]);
      }
      return grouped;
    },
    listSkillsFromDir: mock(async () => []),
    readSkillDetailFromMd: mock(async () => null),
    writeSkillMd: mock(async (dir: string) => `${dir}/SKILL.md`),
    deleteSkillDir: mock(async () => {}),
    resolveImportPlan: (grouped: Map<string, UploadSkillFile[]>, conflicts: unknown[], strategy?: string) => {
      const conflictNames = new Set((conflicts as Array<{ name: string }>).map((item) => item.name));
      return {
        pendingEntries: [...grouped.entries()].filter(([name]) => strategy !== "ignore" || !conflictNames.has(name)),
        skipped: [],
      };
    },
    writeImportFiles: mock(async (_dir: string, entries: [string, UploadSkillFile[]][]) =>
      entries.map(([name]) => name),
    ),
    buildImportedSkillInfos: mock(async (dir: string, names: string[]) =>
      names.map((name) => ({ name, enabled: true, description: `${name} desc`, path: `${dir}/${name}/SKILL.md` })),
    ),
    backupSkillDirs: mock(async (_backupRoot: string, _targetDir: string, names: string[]) => {
      return new Map(names.map((name) => [name, null] as [string, string | null]));
    }),
    cleanupWrittenSkills: mock(async () => {}),
    restoreFromBackup: mock(async () => {}),
    createBackupDir: mock(async () => "/tmp/backup"),
    cleanupBackupDir: mock(async () => {}),
  };

  _deps.configPg = configPg as any;
  _deps.skillFs = skillFs as any;
  return { configPg, skillFs };
}

beforeEach(() => {
  setConfig({ skillDir: root });
});

afterEach(() => {
  _resetDeps();
});

describe("skill archive lifecycle", () => {
  // setSkill 写入文件后生成 archive，并把 SKILL.md 路径写入 PG。
  test("setSkill builds archive before upsert", async () => {
    const { configPg, skillFs } = installMocks();

    await setSkill(ctx, "demo", { description: "Demo", content: "# Demo" });

    expect(skillFs.buildSkillArchive).toHaveBeenCalledWith(`${root}/demo`, `${root}/demo.zip`);
    const upsertCalls = configPg.upsertSkill.mock.calls as unknown as Array<[unknown, string, { contentPath: string }]>;
    expect(upsertCalls[0]?.[2].contentPath).toBe(`${root}/demo/SKILL.md`);
  });

  // 新建 skill 的 PG 写入失败时，清理新 source 与 archive。
  test("setSkill cleans new source and archive when upsert fails", async () => {
    const { configPg, skillFs } = installMocks();
    configPg.upsertSkill.mockImplementationOnce(async () => {
      throw new Error("pg down");
    });

    await expect(setSkill(ctx, "new-skill", { description: "New", content: "# New" })).rejects.toThrow("pg down");

    expect(skillFs.cleanupWrittenSkills).toHaveBeenCalledWith(root, ["new-skill"]);
    expect(skillFs.deleteSkillArchive).toHaveBeenCalledWith(root, "new-skill");
  });

  // 编辑已有 skill 的 PG 写入失败时，恢复旧 source 并重建旧 archive。
  test("setSkill restores existing archive when upsert fails", async () => {
    const { configPg, skillFs } = installMocks();
    skillFs.backupSkillDirs.mockImplementationOnce(async () => new Map([["demo", "/tmp/backup/demo"]]));
    configPg.upsertSkill.mockImplementationOnce(async () => {
      throw new Error("pg down");
    });

    await expect(setSkill(ctx, "demo", { description: "Demo", content: "# Demo" })).rejects.toThrow("pg down");

    expect(skillFs.restoreFromBackup).toHaveBeenCalledWith(new Map([["demo", "/tmp/backup/demo"]]), root);
    expect(skillFs.buildSkillArchive).toHaveBeenCalledTimes(2);
    const archiveCalls = skillFs.buildSkillArchive.mock.calls as unknown as Array<[string, string]>;
    expect(archiveCalls[1]).toEqual([`${root}/demo`, `${root}/demo.zip`]);
  });

  // 删除 PG 元数据成功后，同步删除 source 和 archive。
  test("deleteSkill removes source dir and archive", async () => {
    const { skillFs } = installMocks();

    await expect(deleteSkill(ctx, "demo")).resolves.toBe(true);

    expect(skillFs.deleteSkillDir).toHaveBeenCalledWith(`${root}/demo`);
    expect(skillFs.deleteSkillArchive).toHaveBeenCalledWith(root, "demo");
  });

  // 全局导入成功后，每个 imported skill 都会生成 archive。
  test("importSkillDirectories builds archive for imported skills", async () => {
    const { skillFs } = installMocks();

    await importSkillDirectories(ctx, [makeFile("one"), makeFile("two")]);

    expect(skillFs.buildSkillArchive).toHaveBeenCalledWith(`${root}/one`, `${root}/one.zip`);
    expect(skillFs.buildSkillArchive).toHaveBeenCalledWith(`${root}/two`, `${root}/two.zip`);
  });

  // overwrite 回滚时清理 attempted archive，恢复旧 source 并重建旧 archive。
  test("importSkillDirectories rebuilds archive after overwrite rollback", async () => {
    const { configPg, skillFs } = installMocks();
    configPg.getSkill.mockImplementationOnce(
      async () => ({ name: "demo", enabled: true, contentPath: `${root}/demo/SKILL.md` }) as unknown as null,
    );
    skillFs.backupSkillDirs.mockImplementationOnce(async () => new Map([["demo", "/tmp/backup/demo"]]));
    skillFs.buildImportedSkillInfos.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    await expect(importSkillDirectories(ctx, [makeFile("demo")], "overwrite")).rejects.toThrow("disk full");

    expect(skillFs.deleteSkillArchive).toHaveBeenCalledWith(root, "demo");
    expect(skillFs.buildSkillArchive).toHaveBeenCalledWith(`${root}/demo`, `${root}/demo.zip`);
    expect(skillFs.restoreFromBackup).toHaveBeenCalledWith(new Map([["demo", "/tmp/backup/demo"]]), root);
    expect(skillFs.cleanupBackupDir).toHaveBeenCalledWith("/tmp/backup");
  });
});
