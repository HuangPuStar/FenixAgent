import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DataMigrationContext } from "@fenix/platform-sdk";
import {
  _deps,
  _resetDeps,
  migrateSkillStorageByOrganization,
} from "../../db/data-migrations/migrate-skill-storage-by-organization";

/**
 * 执行上下文由 runner 注入（§6.3）：用例把 `log` 与 `warn` 收到同一份日志里，
 * 从而同时断言「跳过的目标有告警」与「已完成的分发有审计信号」。
 */
function createContext(): { context: DataMigrationContext; logs: string[]; warns: string[] } {
  const logs: string[] = [];
  const warns: string[] = [];
  return { context: { log: (message) => logs.push(message), warn: (message) => warns.push(message) }, logs, warns };
}

describe("skill storage migrate", () => {
  let root: string;

  beforeEach(async () => {
    _resetDeps();
    root = await mkdtemp(join(tmpdir(), "skill-storage-migrate-"));
    _deps.getSkillRoot = () => root;
  });

  afterEach(async () => {
    _resetDeps();
    await rm(root, { recursive: true, force: true });
  });

  // 旧目录存在时，应复制到 org 目录、重建 archive，并删除旧目录和旧 zip。
  test("moves legacy skill directory into organization-scoped location and rebuilds archive", async () => {
    await mkdir(join(root, "demo", "references"), { recursive: true });
    await writeFile(join(root, "demo", "SKILL.md"), "# Demo", "utf-8");
    await writeFile(join(root, "demo", "references", "ref.md"), "ref", "utf-8");
    await writeFile(join(root, "demo.zip"), "legacy", "utf-8");
    _deps.listSkills = async () => [{ organizationId: "org-a", name: "demo" }];
    const { context } = createContext();

    await migrateSkillStorageByOrganization.run(context);

    expect(existsSync(join(root, "org-a", "demo", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "org-a", "demo.zip"))).toBe(true);
    expect(existsSync(join(root, "demo"))).toBe(false);
    expect(existsSync(join(root, "demo.zip"))).toBe(false);
    const archive = await readFile(join(root, "org-a", "demo.zip"));
    expect(archive.length).toBeGreaterThan(0);
  });

  // 同一个旧 skill 被多个组织引用时，应为每个组织都复制一份，避免后续组织丢 skill。
  test("copies one legacy skill into every referenced organization before deleting legacy source", async () => {
    await mkdir(join(root, "shared", "references"), { recursive: true });
    await writeFile(join(root, "shared", "SKILL.md"), "# Shared", "utf-8");
    await writeFile(join(root, "shared", "references", "ref.md"), "ref", "utf-8");
    await writeFile(join(root, "shared.zip"), "legacy", "utf-8");
    _deps.listSkills = async () => [
      { organizationId: "test1", name: "shared" },
      { organizationId: "test2", name: "shared" },
    ];
    const { context } = createContext();

    await migrateSkillStorageByOrganization.run(context);

    expect(existsSync(join(root, "test1", "shared", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "test1", "shared.zip"))).toBe(true);
    expect(existsSync(join(root, "test2", "shared", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "test2", "shared.zip"))).toBe(true);
    expect(existsSync(join(root, "shared"))).toBe(false);
    expect(existsSync(join(root, "shared.zip"))).toBe(false);
  });

  // 目标目录已存在时保守跳过，不删除旧目录，避免误伤人工处理过的数据。
  test("skips deletion when both legacy and target directories exist", async () => {
    await mkdir(join(root, "demo"), { recursive: true });
    await writeFile(join(root, "demo", "SKILL.md"), "# Legacy", "utf-8");
    await mkdir(join(root, "org-a", "demo"), { recursive: true });
    await writeFile(join(root, "org-a", "demo", "SKILL.md"), "# Target", "utf-8");
    _deps.listSkills = async () => [{ organizationId: "org-a", name: "demo" }];
    const { context, warns } = createContext();

    await migrateSkillStorageByOrganization.run(context);

    expect(existsSync(join(root, "demo", "SKILL.md"))).toBe(true);
    expect(warns).toEqual([expect.stringContaining("skip existing target")]);
  });

  // 校验从目标侧断言「组织目录都已就位」：跳过分支留下的旧目录必须与组织目录成对存在。
  test("verify fails when a kept legacy directory has no organization copy", async () => {
    await mkdir(join(root, "demo"), { recursive: true });
    await writeFile(join(root, "demo", "SKILL.md"), "# Legacy", "utf-8");
    _deps.listSkills = async () => [{ organizationId: "org-a", name: "demo" }];
    const { context } = createContext();

    await expect(migrateSkillStorageByOrganization.verify(context)).rejects.toThrow(
      "仍有 1 个 skill 的遗留目录存在但组织目录缺失（如 'org-a/demo'）",
    );
  });

  // 分发完成后旧目录消失，校验无需再求证组织目录，重跑同一条迁移不会误判为未完成。
  test("verify passes once the legacy directory is gone", async () => {
    await mkdir(join(root, "demo"), { recursive: true });
    await writeFile(join(root, "demo", "SKILL.md"), "# Demo", "utf-8");
    _deps.listSkills = async () => [{ organizationId: "org-a", name: "demo" }];
    const { context } = createContext();

    await migrateSkillStorageByOrganization.run(context);

    await expect(migrateSkillStorageByOrganization.verify(context)).resolves.toBeUndefined();
  });
});
