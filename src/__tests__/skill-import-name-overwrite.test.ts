import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setConfig } from "../config";
import { _deps, _resetDeps, importSkillDirectories } from "../services/skill";
import type { UploadSkillFile } from "../services/skill-fs";

const ctx = { organizationId: "org-1", userId: "user-1", role: "owner" } as const;
const root = "/tmp/rcs-skills";

function makeFile(name: string): UploadSkillFile {
  return {
    skillName: name,
    relativePath: "SKILL.md",
    content: `---\nname: ${name}\ndescription: ${name} desc\n---\nBody`,
  };
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
      e.code = "VALIDATION_ERROR";
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
        skipped: strategy === "ignore" ? [...conflictNames] : [],
      };
    },
    writeImportFiles: mock(async (_dir: string, entries: [string, UploadSkillFile[]][]) =>
      entries.map(([name]) => name),
    ),
    buildImportedSkillInfos: mock(async (dir: string, names: string[]) =>
      names.map((name) => {
        const skillMd = entriesByName.get(name)?.find((file) => file.relativePath === "SKILL.md")?.content ?? "";
        const description = skillMd.match(/description:\s*([^\n]+)/)?.[1]?.trim() ?? `${name} desc`;
        return { name, enabled: true, description, path: `${dir}/${name}/SKILL.md` };
      }),
    ),
    backupSkillDirs: mock(async (_backupRoot: string, _targetDir: string, names: string[]) => {
      return new Map(names.map((name) => [name, null] as [string, string | null]));
    }),
    cleanupWrittenSkills: mock(async () => {}),
    restoreFromBackup: mock(async () => {}),
    createBackupDir: mock(async () => "/tmp/backup"),
    cleanupBackupDir: mock(async () => {}),
  };
  const entriesByName = new Map<string, UploadSkillFile[]>();
  skillFs.writeImportFiles.mockImplementation(async (_dir: string, entries: [string, UploadSkillFile[]][]) => {
    for (const [name, files] of entries) entriesByName.set(name, files);
    return entries.map(([name]) => name);
  });

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

describe("skill import name overwrite semantics", () => {
  // 首次同名上传只返回 conflicts，不进入任何破坏性写入链路。
  test("首次同名上传返回 conflicts 且不写入文件和 PG", async () => {
    const { configPg, skillFs } = installMocks();
    configPg.getSkill.mockImplementationOnce(
      async () => ({ name: "demo", enabled: true, contentPath: `${root}/demo/SKILL.md` }) as unknown as null,
    );

    const result = await importSkillDirectories(ctx, [makeFile("demo")]);

    expect(result).toEqual({
      imported: [],
      skipped: [],
      conflicts: [{ name: "demo", enabled: true, path: `${root}/demo/SKILL.md` }],
    });
    expect(skillFs.writeImportFiles).not.toHaveBeenCalled();
    expect(skillFs.cleanupWrittenSkills).not.toHaveBeenCalled();
    expect(configPg.deleteSkill).not.toHaveBeenCalled();
    expect(configPg.upsertSkill).not.toHaveBeenCalled();
    expect(skillFs.buildSkillArchive).not.toHaveBeenCalled();
  });

  // ignore 策略跳过已有目录，继续导入同批次中的新目录。
  test("ignore 策略跳过冲突目录并导入非冲突目录", async () => {
    const { configPg } = installMocks();
    configPg.getSkill.mockImplementation(async (...args: unknown[]) => {
      const name = args[1];
      return typeof name === "string" && name === "existing"
        ? ({ name, enabled: true, contentPath: `${root}/${name}/SKILL.md` } as unknown as null)
        : null;
    });

    const result = await importSkillDirectories(ctx, [makeFile("existing"), makeFile("fresh")], "ignore");

    expect(result.imported.map((item) => item.name)).toEqual(["fresh"]);
    expect(result.skipped).toEqual(["existing"]);
    expect(result.conflicts).toEqual([]);
    expect(configPg.deleteSkill).not.toHaveBeenCalled();
    expect(configPg.upsertSkill).toHaveBeenCalledWith(ctx, "fresh", {
      description: "fresh desc",
      contentPath: `${root}/fresh/SKILL.md`,
    });
  });

  // overwrite 策略以上传目录名作为身份，即使 frontmatter name 不同也不改变覆盖目标。
  test("overwrite 策略使用目录名覆盖并忽略 frontmatter name", async () => {
    const { configPg } = installMocks();
    const file = {
      skillName: "folder-name",
      relativePath: "SKILL.md",
      content: "---\nname: other-name\ndescription: New\n---\nBody",
    };
    configPg.getSkill.mockImplementationOnce(
      async () =>
        ({ name: "folder-name", enabled: true, contentPath: `${root}/folder-name/SKILL.md` }) as unknown as null,
    );

    const result = await importSkillDirectories(ctx, [file], "overwrite");

    expect(configPg.deleteSkill).toHaveBeenCalledWith(ctx, "folder-name");
    expect(configPg.upsertSkill).toHaveBeenCalledWith(ctx, "folder-name", {
      description: "New",
      contentPath: `${root}/folder-name/SKILL.md`,
    });
    expect(result.imported[0]?.name).toBe("folder-name");
  });

  // 批内大小写不同的同名目录应在写入前失败，避免覆盖语义不明确。
  test("同一批上传目录名重复时抛出验证错误", async () => {
    const { configPg, skillFs } = installMocks();
    skillFs.groupUploadFiles = mock((files: UploadSkillFile[]) => {
      const seen = new Set<string>();
      const grouped = new Map<string, UploadSkillFile[]>();
      for (const file of files) {
        const key = file.skillName.trim().toLowerCase();
        if (seen.has(key)) throw skillFs.createSkillValidationError("Duplicate skill names in upload: demo");
        seen.add(key);
        grouped.set(file.skillName.trim(), [file]);
      }
      return grouped;
    });
    _deps.skillFs = skillFs as any;

    await expect(
      importSkillDirectories(ctx, [makeFile("demo"), { ...makeFile("Demo"), skillName: "Demo" }]),
    ).rejects.toThrow("Duplicate skill names in upload: demo");

    expect(configPg.getSkill).not.toHaveBeenCalled();
    expect(skillFs.writeImportFiles).not.toHaveBeenCalled();
    expect(configPg.upsertSkill).not.toHaveBeenCalled();
  });
});
