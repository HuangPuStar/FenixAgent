// web/__tests__/workflow-list-model.test.ts
// 列表页模型层的**分支优先级**：这几个判断决定「界面上出现哪一屏」，误判的形态都是静默的——
// 「上游没绑定」渲染成空表、「没探到绑定」渲染成已就绪，看起来都像合法结果。
//
// 页面级的数据流（真实渲染 + fetch 桩）在 `workflow-list-page.test.tsx`；这里只钉纯函数的判据与边界，
// 让分支表可以被逐条读出来。

import { describe, expect, test } from "bun:test";
import { ApiError } from "@fenix/web-runtime/api/request";
import type { WorkflowV2OrgAppBinding } from "../api/canvas-session";
import type { WorkflowV2WorkflowItem } from "../api/workflows";
import {
  deleteRefusalKey,
  describeWorkflowStatus,
  initializeErrorKey,
  resolveDeleteOutcome,
  resolveListViewState,
  resolveUpdatedAt,
  UPDATED_AT_KEYS,
} from "../pages/list/workflow-list-model";

const ITEM: WorkflowV2WorkflowItem = {
  id: "wf-1",
  upstreamWorkflowId: "upstream-1",
  appId: "app-1",
  name: "示例",
  ownerUserId: "user-1",
  visibility: "private",
  publishedVersion: null,
  syncState: "active",
  updatedAt: "2026-09-29T00:00:00.000Z",
};

const BOUND: WorkflowV2OrgAppBinding = { appId: "app-1", status: "active" };

function snapshot(overrides: Partial<Parameters<typeof resolveListViewState>[0]>) {
  return resolveListViewState({
    loading: false,
    error: null,
    binding: BOUND,
    items: [ITEM],
    total: 1,
    ...overrides,
  });
}

describe("视图状态的分支优先级", () => {
  test("进行中优先于一切（即便上一轮有数据或错误）", () => {
    expect(snapshot({ loading: true, error: new Error("boom"), binding: null }).kind).toBe("loading");
  });

  test("失败优先于上游未就绪与空态", () => {
    expect(snapshot({ error: new Error("boom"), binding: null, items: [], total: 0 }).kind).toBe("failed");
  });

  // 绑定没探到（且没有显式错误）不等于「没绑定」：两者的引导不同，按失败处理让用户能重试。
  test("绑定探测结果缺失按失败处理，而不是未绑定或空态", () => {
    expect(snapshot({ binding: null, items: [], total: 0 }).kind).toBe("failed");
  });

  test("未绑定 / 降级分别给出 blocked 的两个原因", () => {
    const unbound = snapshot({ binding: { appId: null, status: "unbound" } });
    const degraded = snapshot({ binding: { appId: "app-1", status: "degraded" } });
    expect(unbound).toEqual({ kind: "blocked", reason: "unbound" });
    expect(degraded).toEqual({ kind: "blocked", reason: "degraded" });
  });

  // 未绑定但**有**历史记录时仍走引导：那些工作流打开必然失败，渲染成表格比空表更糟。
  test("未绑定时即便列表非空也不进就绪态", () => {
    const state = snapshot({ binding: { appId: null, status: "unbound" }, items: [ITEM], total: 1 });
    expect(state.kind).toBe("blocked");
  });

  test("空列表才是空态，有数据即就绪", () => {
    expect(snapshot({ items: [], total: 0 }).kind).toBe("empty");
    expect(snapshot({ items: [ITEM], total: 3 })).toEqual({ kind: "ready", items: [ITEM], total: 3 });
  });
});

describe("状态列与删除结果", () => {
  test("已发布 / 未发布 / 删除中 三分支各带自己的键与版本号", () => {
    expect(describeWorkflowStatus({ ...ITEM, publishedVersion: "1.2.0" })).toEqual({
      tone: "success",
      labelKey: "list.status.published",
      version: "1.2.0",
    });
    expect(describeWorkflowStatus(ITEM)).toEqual({
      tone: "neutral",
      labelKey: "list.status.unpublished",
      version: null,
    });
    // 删除中优先于已发布：它有版本号但已不是可编辑对象。
    expect(describeWorkflowStatus({ ...ITEM, syncState: "pending_delete", publishedVersion: "1.2.0" })).toEqual({
      tone: "warning",
      labelKey: "list.status.pending_delete",
      version: "1.2.0",
    });
  });

  test("deleted 才是删掉；否则是策略拒绝并保留原因", () => {
    expect(resolveDeleteOutcome({ deleted: true, strategy: 0 })).toEqual({ kind: "deleted" });
    expect(resolveDeleteOutcome({ deleted: false, strategy: 2 })).toEqual({ kind: "refused", strategy: 2 });
  });

  test("拒绝原因按策略值取键，未登记的值（含探不到）走 unknown", () => {
    expect(deleteRefusalKey(1)).toBe("list.delete_refused.reviewing");
    expect(deleteRefusalKey(2)).toBe("list.delete_refused.unpublish_required");
    expect(deleteRefusalKey(7)).toBe("list.delete_refused.unknown");
    expect(deleteRefusalKey(null)).toBe("list.delete_refused.unknown");
  });
});

describe("初始化失败的错误码映射", () => {
  // 三类「下一步动作不同」的失败各自取自己的键：会话失效要重新登录、平台账号不可用要等引导恢复、
  // 上游不可用稍后重试即可。文案取码不取 message——服务端信封原文含上游措辞，不能上屏。
  test("会话失效 / 平台账号不可用 / 上游不可用各取自己的键", () => {
    expect(initializeErrorKey(new ApiError("会话已失效", "UNAUTHENTICATED"))).toBe(
      "list.initialize_failed_unauthorized",
    );
    expect(initializeErrorKey(new ApiError("平台账号不可用", "PLATFORM_SESSION_UNAVAILABLE"))).toBe(
      "list.initialize_failed_session",
    );
    expect(initializeErrorKey(new ApiError("上游繁忙", "UPSTREAM_UNAVAILABLE"))).toBe(
      "list.initialize_failed_upstream",
    );
    expect(initializeErrorKey(new ApiError("上游拒绝", "UPSTREAM_REJECTED"))).toBe("list.initialize_failed_upstream");
  });

  // 未登记的码与非 `ApiError`（本地抛错、null）一律走通用文案：不认识的失败不该被翻译成一句看似精确的承诺。
  test("未登记的错误码与非 ApiError 走通用文案", () => {
    expect(initializeErrorKey(new ApiError("写入失败", "INTERNAL_ERROR"))).toBe("list.initialize_failed");
    expect(initializeErrorKey(new Error("boom"))).toBe("list.initialize_failed");
    expect(initializeErrorKey(null)).toBe("list.initialize_failed");
  });
});

describe("更新时间取样", () => {
  const now = Date.parse("2026-09-29T12:00:00.000Z");
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();

  test("四档边界各自落到对应键", () => {
    expect(resolveUpdatedAt(at(59), now)).toEqual({ kind: "relative", key: UPDATED_AT_KEYS.now, count: 0 });
    expect(resolveUpdatedAt(at(60), now)).toEqual({ kind: "relative", key: UPDATED_AT_KEYS.minutes, count: 1 });
    expect(resolveUpdatedAt(at(3_600), now)).toEqual({ kind: "relative", key: UPDATED_AT_KEYS.hours, count: 1 });
    expect(resolveUpdatedAt(at(172_800), now)).toEqual({ kind: "relative", key: UPDATED_AT_KEYS.days, count: 2 });
  });

  // 未来时间戳（客户端时钟偏差）与「刚刚」同义，不能算出负数。
  test("未来时间戳落在「刚刚」", () => {
    expect(resolveUpdatedAt(at(-120), now)).toEqual({ kind: "relative", key: UPDATED_AT_KEYS.now, count: 0 });
  });

  test("超过一周回退为绝对日期", () => {
    expect(resolveUpdatedAt(at(604_800), now)).toEqual({ kind: "date", iso: at(604_800) });
  });
});
