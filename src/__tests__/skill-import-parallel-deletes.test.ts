import { beforeEach, describe, expect, mock, test } from "bun:test";

// ────────────────────────────────────────────
// Mock 依赖 — mock.module 必须在 import 被测模块之前
// ────────────────────────────────────────────

const deleteSkillMock = mock(async (_ctx: any, _name: string) => true);
const upsertSkillMock = mock(async () => "skill_1");
const getSkillMock = mock<(_ctx: any, _name: string) => Promise<unknown>>(async () => null);

const mockBuildImportedSkillInfos = mock(async (_dir: string, names: string[]) => {
  return names.map((n) => ({ name: n, description: "", path: `/path/${n}/SKILL.md` }));
}) as any;

mock.module("../repositories", () => ({
  environmentRepo: { listByUserId: mock(async () => []) },
}));

mock.module("../services/config-pg", () => ({
  deleteSkill: deleteSkillMock,
  upsertSkill: upsertSkillMock,
  getSkill: getSkillMock,
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
  groupUploadFiles: (files: { skillName: string; relativePath: string; content: string }[]) => {
    const map = new Map<string, { skillName: string; relativePath: string; content: string }[]>();
    for (const f of files) {
      const arr = map.get(f.skillName) ?? [];
      arr.push(f);
      map.set(f.skillName, arr);
    }
    return map;
  },
  listSkillsFromDir: mock(async () => []),
  readSkillDetailFromMd: mock(async () => null),
  writeSkillMd: mock(async (_dir: string, _name: string) => "/path/SKILL.md"),
  deleteSkillDir: mock(async () => {}),
  resolveImportPlan: (grouped: Map<string, unknown>, _conflicts: unknown[], strategy: string | undefined) =>
    ({
      pendingEntries: Array.from(grouped.entries()),
      skipped: [],
    }) as any,
  writeImportFiles: mock(async (_dir: string, entries: [string, unknown][]) => {
    return entries.map(([name]) => name);
  }),
  buildImportedSkillInfos: mockBuildImportedSkillInfos,
  backupSkillDirs: mock(async () => new Map()),
  cleanupWrittenSkills: mock(async () => {}),
  restoreFromBackup: mock(async () => {}),
  createBackupDir: mock(async () => "/tmp/backup"),
  cleanupBackupDir: mock(async () => {}),
}));

// ────────────────────────────────────────────
// 导入被测模块
// ────────────────────────────────────────────

import { importSkillDirectories } from "../services/skill";
import type { UploadSkillFile } from "../services/skill-fs";

beforeEach(() => {
  deleteSkillMock.mockClear();
  upsertSkillMock.mockClear();
  getSkillMock.mockClear();
  mockBuildImportedSkillInfos.mockClear();
  // 重置 mockBuildImportedSkillInfos 为默认行为
  mockBuildImportedSkillInfos.mockImplementation(async (_dir: string, names: string[]) => {
    return names.map((n) => ({ name: n, description: "", path: `/path/${n}/SKILL.md` }));
  });
});

describe("importSkillDirectories PG deletes 并行化", () => {
  function makeFile(skillName: string): UploadSkillFile {
    return { skillName, relativePath: "SKILL.md", content: `---\nname: ${skillName}\n---\nContent` };
  }

  // overwrite 策略下冲突 skill 的 PG delete 应并行执行
  test("overwrite 策略下冲突 skill 的 PG delete 应并行执行", async () => {
    getSkillMock.mockImplementation(async (_ctx: any, name: string) => ({
      name,
      enabled: true,
      contentPath: `/path/${name}/SKILL.md`,
    }));

    await importSkillDirectories(
      { organizationId: "test-team", userId: "user_1", role: "owner" },
      [makeFile("skill-a"), makeFile("skill-b"), makeFile("skill-c")],
      "overwrite",
    );

    expect(deleteSkillMock).toHaveBeenCalledTimes(3);
    const deletedNames = deleteSkillMock.mock.calls.map((c: unknown[]) => c[1] as string).sort();
    expect(deletedNames).toEqual(["skill-a", "skill-b", "skill-c"]);
  });

  // 无冲突时不应调用 deleteSkill
  test("无冲突时不应调用 deleteSkill", async () => {
    getSkillMock.mockImplementation(async () => null);

    await importSkillDirectories(
      { organizationId: "test-team", userId: "user_1", role: "owner" },
      [makeFile("new-skill")],
      "overwrite",
    );

    expect(deleteSkillMock).not.toHaveBeenCalled();
    expect(upsertSkillMock).toHaveBeenCalledTimes(1);
  });

  // rollback 路径下 PG delete 应并行执行（不掩盖原始错误）
  test("rollback 路径下 PG delete 应并行执行（不掩盖原始错误）", async () => {
    mockBuildImportedSkillInfos.mockImplementationOnce(async () => {
      throw new Error("disk full");
    });

    getSkillMock.mockImplementation(async () => null);
    deleteSkillMock.mockImplementation(async () => true);

    await expect(
      importSkillDirectories({ organizationId: "test-team", userId: "user_1", role: "owner" }, [
        makeFile("fail-skill"),
      ]),
    ).rejects.toThrow("disk full");

    expect(deleteSkillMock).toHaveBeenCalledTimes(1);
    expect(deleteSkillMock.mock.calls[0][1]).toBe("fail-skill");
  });

  // rollback 路径中 deleteSkill 失败不掩盖原始错误
  test("rollback 路径中 deleteSkill 失败不掩盖原始错误", async () => {
    mockBuildImportedSkillInfos.mockImplementationOnce(async () => {
      throw new Error("original error");
    });

    getSkillMock.mockImplementation(async () => null);
    deleteSkillMock.mockImplementation(async () => {
      throw new Error("db down");
    });

    await expect(
      importSkillDirectories({ organizationId: "test-team", userId: "user_1", role: "owner" }, [makeFile("fail2")]),
    ).rejects.toThrow("original error");
  });
});
