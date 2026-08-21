import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  deleteWorkflowDef,
  getVersions,
  getVersionYaml,
  getWorkflowDef,
  linkWorkflowSnapshotToWorkflow,
  listWorkflowDefs,
  publishVersion,
  resolveWorkflowExecutionVersion,
  restoreVersionToDraft,
  saveDraft,
  setLatestVersion,
  updateWorkflowMeta,
} from "../repositories/workflow-def";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

const ctx = { organizationId: "org-a", userId: "user-a" };

function workflowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "workflow-a",
    userId: "user-a",
    organizationId: "org-a",
    name: "部署流程",
    description: null,
    latestVersion: 2,
    storagePath: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    ...overrides,
  };
}

function versionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "version-a",
    workflowId: "workflow-a",
    version: 2,
    filePath: "v2.yaml",
    status: "published",
    createdBy: "user-a",
    createdAt: new Date("2026-01-02"),
    ...overrides,
  };
}

function selected<T>(rows: T[]) {
  const result = Promise.resolve(rows);
  const filtered = Object.assign(result, { limit: () => result, orderBy: () => result, for: () => filtered });
  return { from: () => ({ where: () => filtered }) };
}

function queuedSelect(...rows: unknown[][]) {
  let index = 0;
  return () => selected(rows[index++] ?? []);
}

function updated<T>(rows: T[], onSet?: (value: unknown) => void) {
  return () => ({
    set: (value: unknown) => {
      onSet?.(value);
      return { where: () => ({ returning: () => Promise.resolve(rows) }) };
    },
  });
}

beforeEach(resetAllStubs);
afterEach(resetAllStubs);

describe("round46 工作流定义仓储真实行为", () => {
  // 列表查询必须将数据库返回的当前组织记录原样交给调用方。
  test("列表返回当前组织的工作流记录", async () => {
    const rows = [workflowRow()];
    stubDb({ select: () => selected(rows) });

    await expect(listWorkflowDefs(ctx.organizationId)).resolves.toEqual(rows);
  });

  // 单项查询没有记录时应使用 null，而不是泄露 undefined 给路由层。
  test("单项查询空结果返回 null", async () => {
    stubDb({ select: () => selected([]) });

    await expect(getWorkflowDef("missing", ctx.organizationId)).resolves.toBeNull();
  });

  // 单项查询应返回找到的工作流定义。
  test("单项查询返回首个匹配工作流", async () => {
    const row = workflowRow();
    stubDb({ select: () => selected([row]) });

    await expect(getWorkflowDef(row.id, ctx.organizationId)).resolves.toEqual(row);
  });

  // 显式执行版本必须优先于工作流的 latestVersion。
  test("执行版本解析优先使用显式版本", async () => {
    const row = workflowRow({ latestVersion: 2 });
    stubDb({ select: () => selected([row]) });

    await expect(resolveWorkflowExecutionVersion(row.id, ctx.organizationId, 7)).resolves.toEqual({
      version: 7,
      workflow: row,
    });
  });

  // 未传版本时应回退到工作流当前发布版本。
  test("执行版本解析回退到 latestVersion", async () => {
    const row = workflowRow({ latestVersion: 3 });
    stubDb({ select: () => selected([row]) });

    await expect(resolveWorkflowExecutionVersion(row.id, ctx.organizationId)).resolves.toEqual({
      version: 3,
      workflow: row,
    });
  });

  // 尚未发布的工作流也必须获得可执行的草稿版本零值。
  test("执行版本解析将空 latestVersion 回退为草稿版本", async () => {
    const row = workflowRow({ latestVersion: null });
    stubDb({ select: () => selected([row]) });

    await expect(resolveWorkflowExecutionVersion(row.id, ctx.organizationId)).resolves.toEqual({
      version: 0,
      workflow: row,
    });
  });

  // 不属于当前组织的工作流查询为空时，执行解析不得返回任何版本。
  test("执行版本解析在组织隔离查询为空时返回 null", async () => {
    stubDb({ select: () => selected([]) });

    await expect(resolveWorkflowExecutionVersion("foreign-workflow", ctx.organizationId)).resolves.toBeNull();
  });

  // 工作流不存在时版本历史必须短路，不应查询版本表。
  test("版本历史对不存在的当前组织工作流返回空数组", async () => {
    const select = mock(() => selected([]));
    stubDb({ select });

    await expect(getVersions("foreign-workflow", ctx.organizationId)).resolves.toEqual([]);
    expect(select).toHaveBeenCalledTimes(1);
  });

  // 已验证工作流归属后，版本历史应保留数据库的倒序结果。
  test("版本历史返回已发布版本记录", async () => {
    const rows = [versionRow({ version: 3 }), versionRow({ id: "version-b", version: 2 })];
    stubDb({ select: queuedSelect([workflowRow()], rows) });

    await expect(getVersions("workflow-a", ctx.organizationId)).resolves.toEqual(rows);
  });

  // 无 storagePath 且组织查询无记录时不得尝试读取 YAML 文件。
  test("版本 YAML 在当前组织查不到工作流时返回 null", async () => {
    stubDb({ select: () => selected([]) });

    await expect(getVersionYaml("foreign-workflow", 2, { organizationId: ctx.organizationId })).resolves.toBeNull();
  });

  // 旧签名仍要安全降级并提示调用方迁移组织上下文。
  test("旧版 YAML 查询在路径为空时告警并返回 null", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    stubDb({ select: () => selected([]) });

    await expect(getVersionYaml("workflow-a", 2)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  // 回滚前必须确认工作流归属当前组织。
  test("设置最新版本拒绝不存在或跨组织的工作流", async () => {
    stubDb({ select: () => selected([]) });

    await expect(setLatestVersion("foreign-workflow", ctx.organizationId, 2)).rejects.toThrow(
      "Workflow foreign-workflow not found in organization",
    );
  });

  // 工作流存在但版本不属于它时不得更新 latestVersion。
  test("设置最新版本拒绝不存在的版本", async () => {
    const update = mock(updated([]));
    stubDb({ select: queuedSelect([{ id: "workflow-a" }], []), update });

    await expect(setLatestVersion("workflow-a", ctx.organizationId, 9)).rejects.toThrow("Version 9 not found");
    expect(update).not.toHaveBeenCalled();
  });

  // 回滚校验通过后必须提交 latestVersion 更新。
  test("设置最新版本更新已验证的当前组织工作流", async () => {
    const update = mock(updated([]));
    stubDb({ select: queuedSelect([{ id: "workflow-a" }], [versionRow()]), update });

    await expect(setLatestVersion("workflow-a", ctx.organizationId, 2)).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);
  });

  // 删除条件无匹配时必须报告 false，避免误称已删除跨组织资源。
  test("删除跨组织或不存在工作流返回 false", async () => {
    stubDb({ delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) });

    await expect(deleteWorkflowDef("foreign-workflow", ctx.organizationId)).resolves.toBeFalse();
  });

  // 删除成功但存储路径为空时仍应返回成功，且无需文件系统清理。
  test("删除无存储路径的工作流返回 true", async () => {
    stubDb({ delete: () => ({ where: () => ({ returning: () => Promise.resolve([{ storagePath: null }]) }) }) });

    await expect(deleteWorkflowDef("workflow-a", ctx.organizationId)).resolves.toBeTrue();
  });

  // 元数据更新无匹配行时应使用 null 表示组织隔离后的未找到状态。
  test("更新跨组织工作流元数据返回 null", async () => {
    stubDb({ update: updated([]) });

    await expect(updateWorkflowMeta("foreign-workflow", ctx.organizationId, { name: "不可更新" })).resolves.toBeNull();
  });

  // 仅更新名称时不能意外写入 description。
  test("更新名称仅提交名称和更新时间", async () => {
    let updates: unknown;
    const row = workflowRow({ name: "新名称" });
    stubDb({ update: updated([row], (value) => (updates = value)) });

    await expect(updateWorkflowMeta("workflow-a", ctx.organizationId, { name: "新名称" })).resolves.toEqual(row);
    expect(updates).toMatchObject({ name: "新名称" });
    expect(updates).not.toHaveProperty("description");
  });

  // 空字符串描述是显式业务值，不能被当作未提供而忽略。
  test("更新描述接受空字符串", async () => {
    let updates: unknown;
    const row = workflowRow({ description: "" });
    stubDb({ update: updated([row], (value) => (updates = value)) });

    await expect(updateWorkflowMeta("workflow-a", ctx.organizationId, { description: "" })).resolves.toEqual(row);
    expect(updates).toMatchObject({ description: "" });
  });

  // 保存草稿必须先验证工作流属于当前组织并且存在存储目录。
  test("保存草稿拒绝不存在或跨组织的工作流", async () => {
    stubDb({ select: () => selected([]) });

    await expect(saveDraft("foreign-workflow", ctx, "name: hidden")).rejects.toThrow("Workflow not found");
  });

  // 发布事务在行锁查询不到当前组织工作流时必须整体失败。
  test("发布版本在事务中拒绝不存在或跨组织工作流", async () => {
    stubDb({
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({ select: () => selected([]) }),
    });

    await expect(publishVersion("foreign-workflow", ctx)).rejects.toThrow("Workflow not found");
  });

  // 已有路径但不存在草稿文件时，发布不得创建空的发布版本。
  test("发布版本拒绝没有草稿内容的工作流", async () => {
    stubDb({
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({ select: () => selected([workflowRow({ storagePath: "/definitely-not-a-workflow-directory" })]) }),
    });

    await expect(publishVersion("workflow-a", ctx)).rejects.toThrow("No draft to publish");
  });

  // 恢复草稿前找不到指定版本内容时不得调用保存草稿。
  test("恢复不存在版本到草稿时报错", async () => {
    stubDb({ select: () => selected([]) });

    await expect(restoreVersionToDraft("foreign-workflow", ctx, 4)).rejects.toThrow("Version 4 not found");
  });

  // 快照关联只通过 runId 与组织共同限定更新范围。
  test("关联工作流快照执行组织范围内更新", async () => {
    const update = mock(updated([]));
    stubDb({ update });

    await expect(linkWorkflowSnapshotToWorkflow("run-a", ctx.organizationId, "workflow-a")).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);
  });
});
