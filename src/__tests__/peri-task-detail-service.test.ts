import { describe, expect, test } from "bun:test";
import { NotFoundError } from "../errors";
import { getPeriTaskDetail } from "../services/peri-task-detail-service";
import type { PeriTaskDetailStore } from "../services/peri-task-detail-store";

const context = {
  organizationId: "org-1",
  userId: "user-1",
  environmentId: "env-1",
  sessionId: "ses-1",
  taskId: "task-1",
};

function createDeps(record: ReturnType<PeriTaskDetailStore["get"]>) {
  return {
    getOwnedEnvironment: async () => ({ id: "env-1" }),
    store: { get: () => record },
  };
}

const query = { limit: 1 as const, byteLimit: 2_000 };

describe("Peri Task Detail service", () => {
  // Subagent 详情只能返回现有有界摘要，并明确标记不是完整 transcript。
  test("returns an honest subagent preview", async () => {
    const result = await getPeriTaskDetail(
      context,
      query,
      createDeps({ taskId: "task-1", kind: "subagent", summary: "安全摘要", detailAvailability: "preview" }),
    );
    expect(result).toEqual({
      kind: "preview",
      taskId: "task-1",
      taskKind: "subagent",
      items: [{ type: "text", content: "安全摘要" }],
      nextCursor: null,
      complete: false,
      limitation: "source_only_provides_preview",
    });
  });

  // Background 使用相同响应契约但保留 kind，供前端按 kind 渲染。
  test("preserves background kind", async () => {
    const result = await getPeriTaskDetail(
      context,
      query,
      createDeps({ taskId: "task-1", kind: "background", summary: "output preview", detailAvailability: "preview" }),
    );
    expect(result.kind).toBe("preview");
    if (result.kind === "preview") expect(result.taskKind).toBe("background");
  });

  // 多字节摘要必须按 UTF-8 字节限制截断，不能切断字符。
  test("applies UTF-8 byte limit safely", async () => {
    const result = await getPeriTaskDetail(
      context,
      { limit: 1, byteLimit: 4 },
      createDeps({ taskId: "task-1", kind: "subagent", summary: "你好A", detailAvailability: "preview" }),
    );
    expect(result.kind === "preview" ? result.items[0]?.content : null).toBe("你");
  });

  // source 未提供内容时返回 unavailable，不虚构 loader 或空 transcript。
  test("returns unavailable when source provides no detail", async () => {
    const result = await getPeriTaskDetail(
      context,
      query,
      createDeps({ taskId: "task-1", kind: "background", summary: null, detailAvailability: "unavailable" }),
    );
    expect(result).toEqual({ kind: "unavailable", taskId: "task-1", taskKind: "background", reason: "not_provided" });
  });

  // task 不属于服务端重算出的 Session Doc 时统一 404，避免枚举。
  test("rejects task missing from the server-derived session doc", async () => {
    await expect(getPeriTaskDetail(context, query, createDeps(null))).rejects.toBeInstanceOf(NotFoundError);
  });

  // environment owner 校验必须先于 store 读取，跨租户/非 owner 不接触任务数据。
  test("authorizes environment before reading task store", async () => {
    let storeRead = false;
    await expect(
      getPeriTaskDetail(context, query, {
        getOwnedEnvironment: async () => {
          throw new NotFoundError("环境不存在");
        },
        store: {
          get: () => {
            storeRead = true;
            return null;
          },
        },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(storeRead).toBe(false);
  });
});
