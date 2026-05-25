import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { _deps, _resetDeps, importSkillDirectories } from "../services/skill";

const mockGroupUploadFiles = mock(() => new Map());

beforeEach(() => {
  _deps.configPg = {
    getSkill: mock(async () => null),
    upsertSkill: mock(async () => "skill-id"),
    deleteSkill: mock(async () => true),
    listSkills: mock(async () => []),
  } as any;
  _deps.skillFs = {
    assertValidSkillName: (name: string) => name.trim(),
    getSkillSourceDir: (root: string, name: string) => `${root}/${name}`,
    getSkillArchivePath: (root: string, name: string) => `${root}/${name}.zip`,
    buildSkillArchive: mock(async () => {}),
    deleteSkillArchive: mock(async () => {}),
    createSkillValidationError: (msg: string) => {
      const e = new Error(msg) as any;
      e.code = "TEST";
      return e;
    },
    groupUploadFiles: mockGroupUploadFiles,
    readSkillDetailFromMd: mock(async () => null),
    writeSkillMd: mock(async () => "/tmp/skill/SKILL.md"),
    deleteSkillDir: mock(async () => {}),
    resolveImportPlan: mock(() => ({ pendingEntries: [], skipped: [] })),
    writeImportFiles: mock(async () => []),
    buildImportedSkillInfos: mock(async () => []),
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

describe("skill import shared validation", () => {
  it("空文件列表抛出验证错误", async () => {
    await expect(
      importSkillDirectories({ organizationId: "test-org", userId: "user-1", role: "owner" }, []),
    ).rejects.toThrow("未提供任何上传文件");
  });

  it("空 grouped 抛出验证错误", async () => {
    mockGroupUploadFiles.mockImplementationOnce(() => new Map());
    await expect(
      importSkillDirectories({ organizationId: "test-org", userId: "user-1", role: "owner" }, [
        { skillName: "a", relativePath: "other.txt", content: "x" },
      ]),
    ).rejects.toThrow("未解析出任何 skill");
  });

  it("缺少 SKILL.md 抛出验证错误", async () => {
    mockGroupUploadFiles.mockImplementationOnce(
      () => new Map([["bad-skill", [{ skillName: "bad-skill", relativePath: "README.md", content: "x" }]]]),
    );
    await expect(
      importSkillDirectories({ organizationId: "test-org", userId: "user-1", role: "owner" }, [
        { skillName: "bad-skill", relativePath: "bad-skill/README.md", content: "x" },
      ]),
    ).rejects.toThrow('Skill "bad-skill" 缺少 SKILL.md');
  });
});
