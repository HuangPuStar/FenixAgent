// ── listSkillSources 跳过无 workspacePath 的环境 ──
import { describe, test, expect, mock, beforeEach } from "bun:test";

mock.module("../logger", () => ({
  log: mock(),
  error: mock(),
}));
mock.module("../repositories", () => ({
  environmentRepo: {
    listByUserId: mock(async () => []),
  },
}));
mock.module("./config-pg", () => ({
  listSkills: mock(async () => []),
}));
mock.module("./skill-fs", () => ({
  listSkillsFromDir: mock(async () => []),
  createSkillValidationError: (msg: string) => new Error(msg),
  groupUploadFiles: () => new Map(),
  readSkillDetailFromMd: mock(async () => null),
  writeSkillMd: mock(async () => "/tmp/SKILL.md"),
  deleteSkillDir: mock(async () => {}),
  resolveImportPlan: () => ({ pendingEntries: [], skipped: [] }),
  writeImportFiles: mock(async () => []),
  buildImportedSkillInfos: mock(async () => []),
  backupSkillDirs: mock(async () => new Map()),
  cleanupWrittenSkills: mock(async () => {}),
  restoreFromBackup: mock(async () => {}),
  createBackupDir: mock(async () => "/tmp/backup"),
  cleanupBackupDir: mock(async () => {}),
}));

const { listSkillSources } = await import("../services/skill");
const { environmentRepo } = await import("../repositories");

describe("listSkillSources skips environments without workspacePath", () => {
  beforeEach(() => {
    (environmentRepo.listByUserId as ReturnType<typeof mock>).mockReset();
  });

  // 无 workspacePath 的环境不出现在结果中
  test("excludes environments with null workspacePath", async () => {
    (environmentRepo.listByUserId as ReturnType<typeof mock>)
      .mockResolvedValueOnce([
        { id: "env-1", workspacePath: null, name: "ACP Agent", status: "active" },
        { id: "env-2", workspacePath: "/tmp/ws", name: "Web Env", status: "active" },
      ]);

    const sources = await listSkillSources({ teamId: "f0000000-0000-0000-0000-000000000001", userId: "user-1", role: "owner" });
    // 应只有全局源 + env-2 的 workspace 源
    expect(sources.length).toBe(2); // global + env-2
    expect(sources[0].type).toBe("global");
    expect(sources[1].type).toBe("workspace");
    expect(sources[1].id).toBe("env-2");
  });

  // 全部环境无 workspacePath 时仅返回全局源
  test("returns only global source when all envs have null workspacePath", async () => {
    (environmentRepo.listByUserId as ReturnType<typeof mock>)
      .mockResolvedValueOnce([
        { id: "env-1", workspacePath: null, name: "Agent 1", status: "active" },
        { id: "env-2", workspacePath: undefined, name: "Agent 2", status: "active" },
      ]);

    const sources = await listSkillSources({ teamId: "f0000000-0000-0000-0000-000000000001", userId: "user-1", role: "owner" });
    expect(sources.length).toBe(1);
    expect(sources[0].type).toBe("global");
  });

  // 无环境时仅返回全局源
  test("returns only global source when no environments exist", async () => {
    (environmentRepo.listByUserId as ReturnType<typeof mock>)
      .mockResolvedValueOnce([]);

    const sources = await listSkillSources({ teamId: "f0000000-0000-0000-0000-000000000001", userId: "user-1", role: "owner" });
    expect(sources.length).toBe(1);
    expect(sources[0].type).toBe("global");
  });
});
