import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

// @ts-expect-error Bun query import 会加载独立的真实仓储实例，同时 ../db 仍由 preload stubDb Proxy 隔离。
const { createWorkflowDef } = await import("../repositories/workflow-def?round71");

const createdDirectories: string[] = [];

beforeEach(resetAllStubs);
afterEach(async () => {
  resetAllStubs();
  await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("round71 workflow-def 仓储真实映射", () => {
  // 创建工作流必须持久化调用方组织归属，并将组织层纳入后续存储路径。
  test("createWorkflowDef 写入组织字段并生成组织隔离存储路径", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "workflow-def-round71-"));
    createdDirectories.push(baseDir);
    const inserted: unknown[] = [];
    const updated: unknown[] = [];
    const row = {
      id: "workflow-round71",
      userId: "user-round71",
      organizationId: "org-round71",
      name: "组织隔离工作流",
      description: "验证真实仓储映射",
      latestVersion: null,
      storagePath: "",
      createdAt: new Date("2026-08-19T00:00:00.000Z"),
      updatedAt: new Date("2026-08-19T00:00:00.000Z"),
    };

    stubDb({
      insert: () => ({
        values: (value: unknown) => {
          inserted.push(value);
          return { returning: () => Promise.resolve([row]) };
        },
      }),
      update: () => ({
        set: (value: unknown) => {
          updated.push(value);
          return { where: () => Promise.resolve() };
        },
      }),
    });

    const result = await createWorkflowDef(
      { organizationId: "org-round71", userId: "user-round71" },
      { name: "组织隔离工作流", description: "验证真实仓储映射" },
      baseDir,
    );
    const storagePath = join(baseDir, "org-round71", "workflow-round71");

    expect(inserted).toEqual([
      {
        userId: "user-round71",
        organizationId: "org-round71",
        name: "组织隔离工作流",
        description: "验证真实仓储映射",
        storagePath: "",
      },
    ]);
    expect(updated).toEqual([{ storagePath }]);
    expect(result).toEqual({ ...row, storagePath });
    await expect(readdir(storagePath)).resolves.toEqual([]);
  });
});
