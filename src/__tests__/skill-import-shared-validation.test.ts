import { describe, expect, it, mock } from "bun:test";

// mock logger
const mockLog = mock(() => {});
const mockLogError = mock(() => {});
mock.module("../logger", () => ({
  log: mockLog,
  error: mockLogError,
}));

// mock config-pg
mock.module("../services/config-pg", () => ({
  getSkill: mock(() => Promise.resolve(null)),
  upsertSkill: mock(() => Promise.resolve("skill-id")),
  deleteSkill: mock(() => Promise.resolve(true)),
}));

// mock repositories
mock.module("../repositories", () => ({
  environmentRepo: { listByUserId: mock(() => Promise.resolve([])) },
}));

// mock skill-fs
const mockGroupUploadFiles = mock(() => new Map());
const mockValidateImportFiles = mock(() => { throw new Error("should not be called"); });
const mockResolveImportPlan = mock(() => ({ pendingEntries: [], skipped: [] }));
const mockWriteImportFiles = mock(() => Promise.resolve([]));
const mockBuildImportedSkillInfos = mock(() => Promise.resolve([]));
const mockBackupSkillDirs = mock(() => Promise.resolve(new Map()));
const mockCleanupWrittenSkills = mock(() => Promise.resolve());
const mockRestoreFromBackup = mock(() => Promise.resolve());
const mockCreateBackupDir = mock(() => Promise.resolve("/tmp/backup"));
const mockCleanupBackupDir = mock(() => Promise.resolve());
const mockWriteSkillMd = mock(() => Promise.resolve("/tmp/skill/SKILL.md"));
const mockDeleteSkillDir = mock(() => Promise.resolve());
const mockListSkillsFromDir = mock(() => []);
const mockReadSkillDetailFromMd = mock(() => null);
const mockCreateSkillValidationError = (msg: string) => new Error(msg);

mock.module("../services/skill-fs", () => ({
  createSkillValidationError: mockCreateSkillValidationError,
  groupUploadFiles: mockGroupUploadFiles,
  listSkillsFromDir: mockListSkillsFromDir,
  readSkillDetailFromMd: mockReadSkillDetailFromMd,
  writeSkillMd: mockWriteSkillMd,
  deleteSkillDir: mockDeleteSkillDir,
  resolveImportPlan: mockResolveImportPlan,
  writeImportFiles: mockWriteImportFiles,
  buildImportedSkillInfos: mockBuildImportedSkillInfos,
  backupSkillDirs: mockBackupSkillDirs,
  cleanupWrittenSkills: mockCleanupWrittenSkills,
  restoreFromBackup: mockRestoreFromBackup,
  createBackupDir: mockCreateBackupDir,
  cleanupBackupDir: mockCleanupBackupDir,
}));

const { importSkillDirectories, importWorkspaceSkillDirectories } = await import("../services/skill");

describe("skill import shared validation", () => {
  it("空文件列表抛出验证错误", async () => {
    await expect(importSkillDirectories("user-1", [])).rejects.toThrow("未提供任何上传文件");
  });

  it("空 grouped 抛出验证错误", async () => {
    mockGroupUploadFiles.mockImplementationOnce(() => new Map());
    await expect(importSkillDirectories("user-1", [
      { relativePath: "other.txt", content: "x" },
    ])).rejects.toThrow("未解析出任何 skill");
  });

  it("缺少 SKILL.md 抛出验证错误", async () => {
    mockGroupUploadFiles.mockImplementationOnce(() => new Map([
      ["bad-skill", [{ relativePath: "README.md", content: "x" }]],
    ]));
    await expect(importSkillDirectories("user-1", [
      { relativePath: "bad-skill/README.md", content: "x" },
    ])).rejects.toThrow('Skill "bad-skill" 缺少 SKILL.md');
  });

  it("workspace 空文件列表同样抛出验证错误", async () => {
    await expect(importWorkspaceSkillDirectories("/ws", [])).rejects.toThrow("未提供任何上传文件");
  });

  it("workspace 缺少 SKILL.md 抛出验证错误", async () => {
    mockGroupUploadFiles.mockImplementationOnce(() => new Map([
      ["ws-skill", [{ relativePath: "README.md", content: "x" }]],
    ]));
    await expect(importWorkspaceSkillDirectories("/ws", [
      { relativePath: "ws-skill/README.md", content: "x" },
    ])).rejects.toThrow('Skill "ws-skill" 缺少 SKILL.md');
  });
});
