import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setConfig } from "@server/config";
import {
  _deps,
  deleteSkillDocument,
  importSkillDirectories,
  normalizeSkillWriteData,
  resetSkillContentDeps,
  type UploadSkillFile,
  writeSkillDocument,
} from "../server/services/skill-content";

/**
 * Skill 文档内容层用例（`services/skill-content`）。
 *
 * 关注的是**文件系统这个介质自己的一致性规则**：写入前建快照、失败时恢复快照并同步归档、删除时
 * 清理源目录与归档。资源行的写入顺序与补偿由 Facade 负责（见 `skill-facade` 用例），因此这里用文件
 * 系统替身断言调用序列与参数，不触碰真实目录。
 */

const root = "/tmp/rcs-skills";
const organizationId = "org-1";
const targetDir = `${root}/${organizationId}`;
const backupDir = "/tmp/backup";

function makeFile(name: string): UploadSkillFile {
  return { skillName: name, relativePath: "SKILL.md", content: `---\nname: ${name}\n---\nBody` };
}

/** 装入文件系统替身：纯函数（名称校验、分组、冲突规划）用真实实现，磁盘操作全部替换。 */
function installFs() {
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
    createBackupDir: mock(async () => backupDir),
    backupSkillDirs: mock(async (_backupRoot: string, _dir: string, names: string[]) => {
      return new Map(names.map((name) => [name, null] as [string, string | null]));
    }),
    cleanupWrittenSkills: mock(async () => undefined),
    restoreFromBackup: mock(async () => undefined),
    cleanupBackupDir: mock(async () => undefined),
    writeImportFiles: mock(async (_dir: string, entries: [string, UploadSkillFile[]][]) =>
      entries.map(([name]) => name),
    ),
    buildImportedSkillInfos: mock(async (dir: string, names: string[]) =>
      names.map((name) => ({ name, enabled: true, description: `${name} desc`, path: `${dir}/${name}/SKILL.md` })),
    ),
  };

  _deps.skillFs = skillFs as unknown as typeof _deps.skillFs;
  return skillFs;
}

beforeEach(() => {
  setConfig({ skillDir: root });
});

afterEach(() => {
  resetSkillContentDeps();
});

describe("skill 文档写入", () => {
  // 写入顺序：先落盘 SKILL.md，再同步归档，最后才让调用方写资源行——资源行拿到的是已落盘的内容。
  test("writeSkillDocument 先写文件与归档再回调资源行写入", async () => {
    const skillFs = installFs();
    const written: { contentPath: string; description: string; metadata?: Record<string, string> }[] = [];

    await writeSkillDocument({
      organizationId,
      name: "demo",
      description: "Demo",
      content: "# Demo",
      persist: async (result) => {
        written.push(result);
      },
    });

    expect(skillFs.writeSkillMd).toHaveBeenCalledWith(`${targetDir}/demo`, "demo", "Demo", "# Demo", undefined);
    expect(skillFs.buildSkillArchive).toHaveBeenCalledWith(`${targetDir}/demo`, `${targetDir}/demo.zip`);
    expect(written).toEqual([{ contentPath: `${targetDir}/demo/SKILL.md`, description: "Demo" }]);
  });

  // 既有文档里资源行可承载的元数据必须保留并合并本次入参；name / description 由资源行列承载，不入 metadata。
  test("writeSkillDocument 合并既有文档的可入库元数据", async () => {
    const skillFs = installFs();
    skillFs.readSkillDocumentFromMd.mockImplementationOnce(async () => ({
      metadata: { builtin: "true", name: "demo", description: "旧描述" },
      content: "# 旧",
    }));
    const written: { metadata?: Record<string, string> }[] = [];

    await writeSkillDocument({
      organizationId,
      name: "demo",
      description: "新描述",
      content: "# 新",
      metadata: { source: "meta-agent" },
      persist: async (result) => {
        written.push(result);
      },
    });

    expect(skillFs.writeSkillMd).toHaveBeenCalledWith(`${targetDir}/demo`, "demo", "新描述", "# 新", {
      builtin: "true",
      source: "meta-agent",
    });
    expect(written[0]?.metadata).toEqual({ builtin: "true", source: "meta-agent" });
  });

  // 资源行写入失败（新建路径没有快照）：删除半成品内容与刚生成的归档，把原错误原样上抛。
  test("资源行写入失败时清理新建内容与归档", async () => {
    const skillFs = installFs();

    await expect(
      writeSkillDocument({
        organizationId,
        name: "new-skill",
        description: "New",
        content: "# New",
        persist: async () => {
          throw new Error("pg down");
        },
      }),
    ).rejects.toThrow("pg down");

    expect(skillFs.cleanupWrittenSkills).toHaveBeenCalledWith(targetDir, ["new-skill"]);
    expect(skillFs.deleteSkillArchive).toHaveBeenCalledWith(root, organizationId, "new-skill");
    expect(skillFs.buildSkillArchive).toHaveBeenCalledTimes(1);
  });

  // 覆盖既有内容失败（有快照）：恢复旧内容并重建旧归档，文件与归档回到写入前的一致状态。
  test("资源行写入失败时恢复快照并重建归档", async () => {
    const skillFs = installFs();
    skillFs.backupSkillDirs.mockImplementationOnce(async () => new Map([["demo", "/tmp/backup/demo"]]));

    await expect(
      writeSkillDocument({
        organizationId,
        name: "demo",
        description: "Demo",
        content: "# Demo",
        persist: async () => {
          throw new Error("pg down");
        },
      }),
    ).rejects.toThrow("pg down");

    expect(skillFs.restoreFromBackup).toHaveBeenCalledWith(new Map([["demo", "/tmp/backup/demo"]]), targetDir);
    const archiveCalls = skillFs.buildSkillArchive.mock.calls as unknown as Array<[string, string]>;
    expect(archiveCalls).toEqual([
      [`${targetDir}/demo`, `${targetDir}/demo.zip`],
      [`${targetDir}/demo`, `${targetDir}/demo.zip`],
    ]);
    expect(skillFs.cleanupBackupDir).toHaveBeenCalledWith(backupDir);
  });

  // 完整 SKILL.md 被误传到 content 时剥离已有 frontmatter，避免写入重复头部（embedding 的元数据仍保留）。
  test("normalizeSkillWriteData 剥离已有 frontmatter 并合并元数据", () => {
    const normalized = normalizeSkillWriteData({
      description: "Request description",
      content: "---\nname: demo\ndescription: Embedded description\ncategory: testing\n---\n\n# Demo\n",
      metadata: { source: "meta-agent" },
    });

    expect(normalized).toEqual({
      description: "Request description",
      content: "\n# Demo\n",
      metadata: { category: "testing", source: "meta-agent" },
    });
  });
});

describe("skill 内容删除", () => {
  // 删除内容清理源目录与归档；归档缺失不影响结果（清理失败只记录日志，不上抛）。
  test("deleteSkillDocument 清理源目录与归档", async () => {
    const skillFs = installFs();

    await deleteSkillDocument({ organizationId, name: "demo" });

    expect(skillFs.deleteSkillDir).toHaveBeenCalledWith(`${targetDir}/demo`);
    expect(skillFs.deleteSkillArchive).toHaveBeenCalledWith(root, organizationId, "demo");
  });
});

describe("skill 导入归档", () => {
  // 导入成功后每个被写入的技能都要有归档：克隆与下载都从归档读取。
  test("importSkillDirectories 为每个写入的技能建归档", async () => {
    const skillFs = installFs();

    await importSkillDirectories({ organizationId, files: [makeFile("one"), makeFile("two")], conflicts: [] });

    expect(skillFs.buildSkillArchive).toHaveBeenCalledWith(`${targetDir}/one`, `${targetDir}/one.zip`);
    expect(skillFs.buildSkillArchive).toHaveBeenCalledWith(`${targetDir}/two`, `${targetDir}/two.zip`);
  });

  // 覆盖导入失败：回滚被覆盖的资源行与归档，恢复快照，再按恢复后的内容重建归档。
  test("覆盖导入失败时回滚资源行、快照与归档", async () => {
    const skillFs = installFs();
    skillFs.backupSkillDirs.mockImplementationOnce(async () => new Map([["demo", "/tmp/backup/demo"]]));
    skillFs.buildImportedSkillInfos.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });
    const rolledBack: string[][] = [];

    await expect(
      importSkillDirectories({
        organizationId,
        files: [makeFile("demo")],
        conflicts: [{ name: "demo", enabled: true, path: `${targetDir}/demo/SKILL.md` }],
        strategy: "overwrite",
        onRollbackCleanup: async (names) => {
          rolledBack.push([...names]);
        },
      }),
    ).rejects.toThrow("disk full");

    expect(skillFs.cleanupWrittenSkills).toHaveBeenCalledWith(targetDir, ["demo"]);
    expect(rolledBack).toEqual([["demo"]]);
    expect(skillFs.deleteSkillArchive).toHaveBeenCalledWith(root, organizationId, "demo");
    expect(skillFs.restoreFromBackup).toHaveBeenCalledWith(new Map([["demo", "/tmp/backup/demo"]]), targetDir);
    const archiveCalls = skillFs.buildSkillArchive.mock.calls as unknown as Array<[string, string]>;
    expect(archiveCalls).toEqual([[`${targetDir}/demo`, `${targetDir}/demo.zip`]]);
    expect(skillFs.cleanupBackupDir).toHaveBeenCalledWith(backupDir);
  });
});
