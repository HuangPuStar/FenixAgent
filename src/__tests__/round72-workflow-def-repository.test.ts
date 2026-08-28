import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

// @ts-expect-error Bun query import 会加载独立的真实仓储实例，同时 ../db 仍由 preload stubDb Proxy 隔离。
const workflowDef = await import("../repositories/workflow-def?round72");

const ctx = { organizationId: "org-round72", userId: "user-round72" };
const temporaryDirectories: string[] = [];

type QueryRows = Promise<unknown[]> & {
  for: () => QueryRows;
  limit: () => QueryRows;
  orderBy: () => QueryRows;
};

function selected(rows: unknown[]) {
  const result: QueryRows = Object.assign(Promise.resolve(rows), {
    for: () => result,
    limit: () => result,
    orderBy: () => result,
  });
  return { from: () => ({ where: () => result }) };
}

function workflowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "workflow-round72",
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    name: "发布工作流",
    description: "验证仓储映射",
    latestVersion: null,
    storagePath: null,
    createdAt: new Date("2026-08-19T00:00:00.000Z"),
    updatedAt: new Date("2026-08-19T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(resetAllStubs);
afterEach(async () => {
  resetAllStubs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("round72 workflow-def 仓储真实映射", () => {
  // 创建必须写入调用方归属，并在真实临时目录创建按组织隔离的空目录。
  test("createWorkflowDef 持久化组织字段并创建隔离目录", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "workflow-def-round72-"));
    temporaryDirectories.push(baseDir);
    const inserted: unknown[] = [];
    const updated: unknown[] = [];
    const row = workflowRow({ storagePath: "" });

    stubDb({
      insert: () => ({
        values: (value: unknown) => {
          inserted.push(value);
          return { returning: async () => [row] };
        },
      }),
      update: () => ({
        set: (value: unknown) => {
          updated.push(value);
          return { where: async () => undefined };
        },
      }),
    });

    const created = await workflowDef.createWorkflowDef(
      ctx,
      { name: "发布工作流", description: "验证仓储映射" },
      baseDir,
    );
    const storagePath = join(baseDir, ctx.organizationId, row.id);

    expect(inserted).toEqual([
      {
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        name: "发布工作流",
        description: "验证仓储映射",
        storagePath: "",
      },
    ]);
    expect(updated).toEqual([{ storagePath }]);
    expect(created).toEqual({ ...row, storagePath });
    await expect(access(storagePath)).resolves.toBeNull();
  });

  // 列表和单项读取应分别保留排序结果，并把空查询映射为 null。
  test("listWorkflowDefs 返回列表且 getWorkflowDef 将空结果映射为 null", async () => {
    const row = workflowRow();
    const responses = [[row], []];
    stubDb({ select: () => selected(responses.shift() ?? []) });

    await expect(workflowDef.listWorkflowDefs(ctx.organizationId)).resolves.toEqual([row]);
    await expect(workflowDef.getWorkflowDef("missing", ctx.organizationId)).resolves.toBeNull();
  });

  // 保存草稿应写入真实 YAML 文件，并在尚无版本记录时创建 version=0 映射。
  test("saveDraft 写入草稿文件并创建草稿版本", async () => {
    const storagePath = await mkdtemp(join(tmpdir(), "workflow-draft-round72-"));
    temporaryDirectories.push(storagePath);
    const inserted: unknown[] = [];
    const updates: unknown[] = [];

    const selectRows = [[workflowRow({ storagePath })], []];
    stubDb({
      insert: () => ({
        values: (value: unknown) => {
          inserted.push(value);
          return Promise.resolve();
        },
      }),
      select: () => selected(selectRows.shift() ?? []),
      update: () => ({
        set: (value: unknown) => {
          updates.push(value);
          return { where: async () => undefined };
        },
      }),
    });

    await workflowDef.saveDraft("workflow-round72", ctx, "name: 草稿工作流\n");

    await expect(
      workflowDef.getVersionYaml("workflow-round72", 0, { organizationId: ctx.organizationId, storagePath }),
    ).resolves.toBe("name: 草稿工作流\n");
    expect(inserted).toEqual([
      {
        workflowId: "workflow-round72",
        version: 0,
        filePath: "draft.yaml",
        status: "draft",
        createdBy: ctx.userId,
      },
    ]);
    expect(updates).toEqual([{ updatedAt: expect.any(Date) }]);
  });

  // 发布版本应从真实草稿复制 YAML，并将版本号和 latestVersion 映射到事务写入。
  test("publishVersion 复制草稿并写入下一个发布版本", async () => {
    const storagePath = await mkdtemp(join(tmpdir(), "workflow-publish-round72-"));
    temporaryDirectories.push(storagePath);
    await writeFile(join(storagePath, "draft.yaml"), "name: 待发布\n", "utf8");
    const inserted: unknown[] = [];
    const updated: unknown[] = [];
    const version = {
      id: "version-round72",
      workflowId: "workflow-round72",
      version: 2,
      filePath: "v2.yaml",
      status: "published",
      createdBy: ctx.userId,
      createdAt: new Date("2026-08-19T00:00:00.000Z"),
    };
    const tx = {
      insert: () => ({
        values: (value: unknown) => {
          inserted.push(value);
          return { returning: async () => [version] };
        },
      }),
      select: () => selected([workflowRow({ latestVersion: 1, storagePath })]),
      update: () => ({
        set: (value: unknown) => {
          updated.push(value);
          return { where: async () => undefined };
        },
      }),
    };
    stubDb({ transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx) });

    await expect(workflowDef.publishVersion("workflow-round72", ctx)).resolves.toEqual(version);
    await expect(
      workflowDef.getVersionYaml("workflow-round72", 2, { organizationId: ctx.organizationId, storagePath }),
    ).resolves.toBe("name: 待发布\n");
    expect(inserted).toEqual([
      {
        workflowId: "workflow-round72",
        version: 2,
        filePath: "v2.yaml",
        status: "published",
        createdBy: ctx.userId,
      },
    ]);
    expect(updated).toEqual([{ latestVersion: 2 }]);
  });

  // 删除成功时应返回 true，并清理数据库返回的真实工作流目录及其文件。
  test("deleteWorkflowDef 删除存储目录", async () => {
    const storagePath = await mkdtemp(join(tmpdir(), "workflow-delete-round72-"));
    temporaryDirectories.push(storagePath);
    await mkdir(join(storagePath, "nested"));
    await writeFile(join(storagePath, "nested", "workflow.yaml"), "name: 删除验证\n", "utf8");
    stubDb({
      delete: () => ({
        where: () => ({ returning: async () => [{ storagePath }] }),
      }),
    });

    await expect(workflowDef.deleteWorkflowDef("workflow-round72", ctx.organizationId)).resolves.toBeTrue();
    await expect(access(storagePath)).rejects.toThrow();
  });
});
