/**
 * `groupBySpace`（space 分组纯逻辑）的边界测试。
 *
 * 重点覆盖三类越界输入：agent 侧已删除的会话 id、同一会话被多个 space 认领、空 space；
 * 另钉住分组顺序契约：space 按宿主数组顺序（最新的在前）排列，默认分组固定在最底。
 * 本文件不渲染 React、不触碰 DOM，因此不需要 happy-dom / i18n 引导。
 */

import { describe, expect, test } from "bun:test";
import { groupBySpace } from "../chat/lib/space-grouping";
import type { SessionSummary } from "../chat/types";

const DEFAULT_LABEL = "默认";

function session(sessionId: string, updatedAt?: string): SessionSummary {
  return { sessionId, title: sessionId, preview: "", status: "idle", lastMsgTs: 0, updatedAt };
}

/** 组内会话 id 列表（按渲染顺序）。 */
function memberIds(groups: ReturnType<typeof groupBySpace>): string[][] {
  return groups.map((group) => group.sessions.map((item) => item.sessionId));
}

describe("groupBySpace 纯逻辑边界", () => {
  // 未归属会话必须落「默认」分组，且没有 space 时它就是唯一分组。
  test("无 space 时全部会话落默认分组", () => {
    const groups = groupBySpace([session("a"), session("b")], [], DEFAULT_LABEL);
    expect(groups).toHaveLength(1);
    expect(groups[0].spaceId).toBeNull();
    expect(groups[0].name).toBe(DEFAULT_LABEL);
    expect(groups[0].canRename).toBe(false);
    expect(memberIds(groups)).toEqual([["a", "b"]]);
  });

  // 命中 sessionIds 的会话归入对应 space，其余落默认分组，两者不重复出现。
  test("命中归属的会话进入 space，其余落默认", () => {
    const groups = groupBySpace(
      [session("a"), session("b"), session("c")],
      [{ id: "s1", name: "空间一", sessionIds: ["a"] }],
      DEFAULT_LABEL,
    );
    expect(memberIds(groups)).toEqual([["a"], ["b", "c"]]);
  });

  // space 顺序即展示顺序，默认分组固定在最后（不再是第一组）。
  test("space 按数组顺序排列，默认分组固定在最后", () => {
    const groups = groupBySpace(
      [session("a")],
      [
        { id: "s1", name: "空间一", sessionIds: [] },
        { id: "s2", name: "空间二", sessionIds: [] },
      ],
      DEFAULT_LABEL,
    );
    expect(groups.map((group) => group.spaceId)).toEqual(["s1", "s2", null]);
  });

  // 宿主数组由「创建时间倒序」下发：最近新建的 space 排在最前，默认分组仍然垫底。
  test("新建的 space 排在最上，默认分组仍在最底", () => {
    const groups = groupBySpace(
      [session("a"), session("b")],
      [
        { id: "space-new", name: "新建的", sessionIds: [] },
        { id: "space-old", name: "旧的", sessionIds: ["a"] },
      ],
      DEFAULT_LABEL,
    );
    expect(groups.map((group) => group.spaceId)).toEqual(["space-new", "space-old", null]);
    expect(memberIds(groups)).toEqual([[], ["a"], ["b"]]);
  });

  // 空 space 必须保留：分组头承载折叠与「在该分组新建会话」入口，不能因无内容而消失。
  test("空 space 保留为空分组", () => {
    const groups = groupBySpace([session("a")], [{ id: "s1", name: "空间一", sessionIds: [] }], DEFAULT_LABEL);
    expect(groups[0].sessions).toEqual([]);
  });

  // agent 侧已删除的会话 id 只留在 space 的 sessionIds 里，渲染时必须忽略而不是造出幽灵行。
  test("未知会话 id 被忽略", () => {
    const groups = groupBySpace(
      [session("a")],
      [{ id: "s1", name: "空间一", sessionIds: ["ghost", "a"] }],
      DEFAULT_LABEL,
    );
    expect(memberIds(groups)).toEqual([["a"], []]);
  });

  // 同一 space 内重复的 sessionIds 只算一次。
  test("同一 space 内重复 id 去重", () => {
    const groups = groupBySpace([session("a")], [{ id: "s1", name: "空间一", sessionIds: ["a", "a"] }], DEFAULT_LABEL);
    expect(memberIds(groups)).toEqual([["a"], []]);
  });

  // 一个会话只能属于一个 space：后一个认领者按顺序落败，会话不会同时出现在两组。
  test("跨 space 重复归属按顺序取第一个", () => {
    const groups = groupBySpace(
      [session("a")],
      [
        { id: "s1", name: "空间一", sessionIds: ["a"] },
        { id: "s2", name: "空间二", sessionIds: ["a"] },
      ],
      DEFAULT_LABEL,
    );
    expect(memberIds(groups)).toEqual([["a"], [], []]);
  });

  // 组内沿用时间降序（与时间分组同一语义），缺失 updatedAt 视为最早排在末尾。
  test("组内按 updatedAt 降序排列", () => {
    const groups = groupBySpace(
      [session("old", "2026-01-01T00:00:00.000Z"), session("new", "2026-02-01T00:00:00.000Z"), session("none")],
      [{ id: "s1", name: "空间一", sessionIds: ["old", "none", "new"] }],
      DEFAULT_LABEL,
    );
    expect(memberIds(groups)).toEqual([["new", "old", "none"], []]);
  });

  // 只有真实 space 可重命名：默认分组是兜底容器，改名会抹掉「未归属」的语义。
  test("默认分组不可重命名", () => {
    const groups = groupBySpace([], [{ id: "s1", name: "空间一", sessionIds: [] }], DEFAULT_LABEL);
    expect(groups.map((group) => group.canRename)).toEqual([true, false]);
  });
});

// 非法日期不能令 sort comparator 返回 NaN，否则合法的新会话可能被卡在旧条目后面。
test("非法日期视为最早，合法新会话仍排在前面", () => {
  const groups = groupBySpace(
    [session("invalid", "not-a-date"), session("new", "2026-10-15T00:00:00Z")],
    [],
    DEFAULT_LABEL,
  );
  expect(memberIds(groups)).toEqual([["new", "invalid"]]);
});
