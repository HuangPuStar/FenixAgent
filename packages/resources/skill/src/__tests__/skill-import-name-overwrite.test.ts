import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ImportSkillsConflict, UploadSkillFile } from "../server/services/skill-content";
import { _deps, importSkillDirectories, resetSkillContentDeps } from "../server/services/skill-content";
import { initializeSkillModuleConfig } from "../server/testing";

/**
 * 导入的冲突与覆盖语义用例（内容层）。
 *
 * 冲突集合由调用方给出（只有它持有授权信息：其他组织公开的同名技能不算冲突），内容层只按策略规划
 * 写入并回调资源行写入。冲突探测本身在 Facade，见 `skill-facade` 用例。
 */

const root = "/tmp/rcs-skills";
const organizationId = "org-1";
const targetDir = `${root}/${organizationId}`;

function makeFile(name: string, content = `---\nname: ${name}\ndescription: ${name} desc\n---\nBody`): UploadSkillFile {
  return { skillName: name, relativePath: "SKILL.md", content };
}

function conflictOf(name: string): ImportSkillsConflict {
  return { name, enabled: true, path: `${targetDir}/${name}/SKILL.md` };
}

/** 装入文件系统替身；写入与回调是断言点，路径解析用真实拼装规则。 */
function installFs() {
  const writtenByName = new Map<string, UploadSkillFile[]>();
  const skillFs = {
    assertValidSkillName: _deps.skillFs.assertValidSkillName,
    createSkillValidationError: _deps.skillFs.createSkillValidationError,
    groupUploadFiles: _deps.skillFs.groupUploadFiles,
    resolveImportPlan: _deps.skillFs.resolveImportPlan,
    getSkillOrganizationDir: (_skillRoot: string, orgId: string) => `${_skillRoot}/${orgId}`,
    getSkillSourceDir: (_skillRoot: string, orgId: string, name: string) => `${_skillRoot}/${orgId}/${name}`,
    getSkillMdPath: (_skillRoot: string, orgId: string, name: string) => `${_skillRoot}/${orgId}/${name}/SKILL.md`,
    getSkillArchivePath: (_skillRoot: string, orgId: string, name: string) => `${_skillRoot}/${orgId}/${name}.zip`,
    readSkillDetailFromMd: mock(async () => null),
    readSkillDocumentFromMd: mock(async () => null),
    writeSkillMd: mock(async (dir: string) => `${dir}/SKILL.md`),
    buildSkillArchive: mock(async () => undefined),
    deleteSkillArchive: mock(async () => undefined),
    deleteSkillDir: mock(async () => undefined),
    createBackupDir: mock(async () => "/tmp/backup"),
    backupSkillDirs: mock(async (_backupRoot: string, _dir: string, names: string[]) => {
      return new Map(names.map((name) => [name, `/tmp/backup/${name}`] as [string, string]));
    }),
    cleanupWrittenSkills: mock(async () => undefined),
    restoreFromBackup: mock(async () => undefined),
    cleanupBackupDir: mock(async () => undefined),
    writeImportFiles: mock(async (_dir: string, entries: [string, UploadSkillFile[]][]) => {
      for (const [name, files] of entries) writtenByName.set(name, files);
      return entries.map(([name]) => name);
    }),
    buildImportedSkillInfos: mock(async (dir: string, names: string[]) =>
      names.map((name) => ({
        name,
        enabled: true,
        description:
          writtenByName
            .get(name)?.[0]
            ?.content.match(/description:\s*([^\n]+)/)?.[1]
            ?.trim() ?? "",
        path: `${dir}/${name}/SKILL.md`,
      })),
    ),
  };
  _deps.skillFs = skillFs as unknown as typeof _deps.skillFs;
  return skillFs;
}

beforeEach(() => {
  initializeSkillModuleConfig({ skillDir: root });
});

afterEach(() => {
  resetSkillContentDeps();
});

describe("导入的冲突与覆盖", () => {
  // 有冲突但没有策略时只返回冲突清单：用户还没决定，任何写入都是破坏性的。
  test("有冲突且未给策略时只返回冲突清单", async () => {
    const skillFs = installFs();

    const result = await importSkillDirectories({
      organizationId,
      files: [makeFile("demo")],
      conflicts: [conflictOf("demo")],
    });

    expect(result).toEqual({ imported: [], skipped: [], conflicts: [conflictOf("demo")] });
    expect(skillFs.writeImportFiles).not.toHaveBeenCalled();
    expect(skillFs.createBackupDir).not.toHaveBeenCalled();
  });

  // ignore 策略跳过冲突目标，同批次中的其他技能照常导入，被跳过的名称回传给调用方。
  test("ignore 策略跳过冲突目标并导入其余技能", async () => {
    const skillFs = installFs();
    const written: string[] = [];

    const result = await importSkillDirectories({
      organizationId,
      files: [makeFile("existing"), makeFile("fresh")],
      conflicts: [conflictOf("existing")],
      strategy: "ignore",
      onSkillWritten: async (info) => {
        written.push(info.name);
      },
    });

    expect(result.imported.map((item) => item.name)).toEqual(["fresh"]);
    expect(result.skipped).toEqual(["existing"]);
    expect(result.conflicts).toEqual([]);
    expect(written).toEqual(["fresh"]);
    expect(skillFs.buildSkillArchive).toHaveBeenCalledWith(`${targetDir}/fresh`, `${targetDir}/fresh.zip`);
    expect(skillFs.buildSkillArchive).not.toHaveBeenCalledWith(`${targetDir}/existing`, `${targetDir}/existing.zip`);
  });

  // 覆盖目标以上传目录名为身份：SKILL.md 头部写着别的 name 也不改变写入与回调的名称。
  test("overwrite 策略按目录名覆盖并忽略 frontmatter name", async () => {
    const skillFs = installFs();
    const written: string[] = [];
    const file = makeFile("folder-name", "---\nname: other-name\ndescription: New\n---\nBody");

    const result = await importSkillDirectories({
      organizationId,
      files: [file],
      conflicts: [conflictOf("folder-name")],
      strategy: "overwrite",
      onSkillWritten: async (info) => {
        written.push(info.name);
      },
    });

    expect(written).toEqual(["folder-name"]);
    expect(result.imported.map((item) => item.name)).toEqual(["folder-name"]);
    // 覆盖前先备份旧目录（可恢复），而不是先删除旧内容。
    expect(skillFs.backupSkillDirs).toHaveBeenCalledWith("/tmp/backup", targetDir, ["folder-name"]);
    expect(skillFs.cleanupWrittenSkills).toHaveBeenCalledWith(targetDir, ["folder-name"]);
  });

  // 资源行回滚失败不能掩盖原始错误：调用方要看到真正让导入失败的原因。
  test("回滚回调失败不掩盖原始错误", async () => {
    const skillFs = installFs();
    skillFs.buildImportedSkillInfos.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    await expect(
      importSkillDirectories({
        organizationId,
        files: [makeFile("fail-skill")],
        conflicts: [],
        onRollbackCleanup: async () => {
          throw new Error("db down");
        },
      }),
    ).rejects.toThrow("disk full");
  });
});
