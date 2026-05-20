import { describe, expect, it, mock } from "bun:test";

// ────────────────────────────────────────────
// Mock 依赖 — mock.module 必须在 import 被测模块之前
// ────────────────────────────────────────────

const mockGroupUploadFiles = mock(() => new Map());

mock.module("../repositories", () => ({
  environmentRepo: { listByUserId: mock(async () => []) },
}));

mock.module("../services/config-pg", () => ({
  getSkill: mock(async () => null),
  upsertSkill: mock(async () => "skill-id"),
  deleteSkill: mock(async () => true),
  listSkills: mock(async () => []),
  enableSkill: mock(async () => true),
  disableSkill: mock(async () => true),
}));

mock.module("../services/skill-fs", () => ({
  createSkillValidationError: (msg: string) => {
    const e = new Error(msg) as any;
    e.code = "TEST";
    return e;
  },
  groupUploadFiles: mockGroupUploadFiles,
  listSkillsFromDir: mock(async () => []),
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
}));

// ────────────────────────────────────────────
// 导入被测模块
// ────────────────────────────────────────────

import { importSkillDirectories, importWorkspaceSkillDirectories } from "../services/skill";

describe("skill import shared validation", () => {
  // 空文件列表抛出验证错误
  it("空文件列表抛出验证错误", async () => {
    await expect(
      importSkillDirectories({ organizationId: "test-team", userId: "user-1", role: "owner" }, []),
    ).rejects.toThrow("未提供任何上传文件");
  });

  // 空 grouped 抛出验证错误
  it("空 grouped 抛出验证错误", async () => {
    mockGroupUploadFiles.mockImplementationOnce(() => new Map());
    await expect(
      importSkillDirectories({ organizationId: "test-team", userId: "user-1", role: "owner" }, [
        { skillName: "a", relativePath: "other.txt", content: "x" },
      ]),
    ).rejects.toThrow("未解析出任何 skill");
  });

  // 缺少 SKILL.md 抛出验证错误
  it("缺少 SKILL.md 抛出验证错误", async () => {
    mockGroupUploadFiles.mockImplementationOnce(
      () => new Map([["bad-skill", [{ skillName: "bad-skill", relativePath: "README.md", content: "x" }]]]),
    );
    await expect(
      importSkillDirectories({ organizationId: "test-team", userId: "user-1", role: "owner" }, [
        { skillName: "bad-skill", relativePath: "bad-skill/README.md", content: "x" },
      ]),
    ).rejects.toThrow('Skill "bad-skill" 缺少 SKILL.md');
  });

  // workspace 空文件列表同样抛出验证错误
  it("workspace 空文件列表同样抛出验证错误", async () => {
    await expect(importWorkspaceSkillDirectories("/ws", [])).rejects.toThrow("未提供任何上传文件");
  });

  // workspace 缺少 SKILL.md 抛出验证错误
  it("workspace 缺少 SKILL.md 抛出验证错误", async () => {
    mockGroupUploadFiles.mockImplementationOnce(
      () => new Map([["ws-skill", [{ skillName: "ws-skill", relativePath: "README.md", content: "x" }]]]),
    );
    await expect(
      importWorkspaceSkillDirectories("/ws", [
        { skillName: "ws-skill", relativePath: "ws-skill/README.md", content: "x" },
      ]),
    ).rejects.toThrow('Skill "ws-skill" 缺少 SKILL.md');
  });
});
