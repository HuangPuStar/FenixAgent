/**
 * `resolveDropTarget` / `applyAssignmentOverrides` / `pruneSettledOverrides`（space 归属纯逻辑）的边界测试。
 *
 * 这三条是拖放行为的全部决策：落点要不要写、写到哪个分组、宿主快照回来前后本地怎么画。
 * 组件层只把它们接上 dnd-kit 与回调，因此这里覆盖的分支就是用户能遇到的归宿分支。
 * 本文件不渲染 React、不触碰 DOM，因此不需要 happy-dom / i18n 引导。
 */

import { describe, expect, test } from "bun:test";
import {
  applyAssignmentOverrides,
  DEFAULT_SPACE_DROP_ID,
  pruneSettledOverrides,
  resolveDropTarget,
  toSpaceDropId,
} from "../chat/lib/space-drop-target";
import { groupBySpace } from "../chat/lib/space-grouping";
import type { SessionSummary } from "../chat/types";

const DEFAULT_LABEL = "默认";

/** 两个 space（s1 持有会话 `a`）+ 默认分组（会话 `b` 未归属，渲染时排在最后）。 */
const SPACES = [
  { id: "s1", name: "空间一", sessionIds: ["a"] },
  { id: "s2", name: "空间二", sessionIds: [] },
];

function session(sessionId: string): SessionSummary {
  return { sessionId, title: sessionId, preview: "", status: "idle", lastMsgTs: 0 };
}

/** 侧栏当前渲染出的分组（默认分组排在最底）。 */
function groups() {
  return groupBySpace([session("a"), session("b")], SPACES, DEFAULT_LABEL);
}

/** 默认分组（渲染顺序在最后）；落点语义靠分组 id 匹配，但用例仍需按位置取默认分组做断言。 */
function defaultGroup() {
  const rendered = groups();
  return rendered[rendered.length - 1];
}

describe("resolveDropTarget 落点语义", () => {
  // 拖到「默认」分组表示移出归属：默认分组的定义就是「未被任何 space 认领」。
  test("拖到默认分组等于移出归属", () => {
    expect(resolveDropTarget("a", DEFAULT_SPACE_DROP_ID, groups())).toEqual({ kind: "unassign" });
  });

  // 拖到会话当前所在分组不改归属：写进去只会得到同一份归属，却多一次网络往返。
  test("拖到自身所在分组等于不改", () => {
    expect(resolveDropTarget("a", toSpaceDropId("s1"), groups())).toBeNull();
  });

  // 未归属会话拖到默认分组同样是不改：它已经在默认分组里。
  test("未归属会话拖到默认分组等于不改", () => {
    expect(resolveDropTarget("b", DEFAULT_SPACE_DROP_ID, groups())).toBeNull();
  });

  // 认不出的落点（别的 Droppable、已被删除的分组）不改归属，而不是就近猜测。
  test("未知落点等于不改", () => {
    expect(resolveDropTarget("a", "space:ghost", groups())).toBeNull();
  });

  // 松手在分组之外（列表空白处、窗口外）没有落点，不改归属。
  test("没有落点等于不改", () => {
    expect(resolveDropTarget("a", null, groups())).toBeNull();
    expect(resolveDropTarget("a", undefined, groups())).toBeNull();
  });

  // 拖到别的分组是归属写入，落点 id 的前缀要还原成真实 space id。
  test("拖到其它分组产出 assign 意图", () => {
    expect(resolveDropTarget("a", toSpaceDropId("s2"), groups())).toEqual({ kind: "assign", spaceId: "s2" });
  });

  // 宿主快照里找不到的会话（拖起的行来自上一帧）按「当前无归属」处理：拖到 space 是幂等写。
  test("会话不在任何已渲染分组时拖到 space 仍是 assign", () => {
    expect(resolveDropTarget("ghost", toSpaceDropId("s1"), groups())).toEqual({
      kind: "assign",
      spaceId: "s1",
    });
  });

  // 放置目标 id 必须与分组一一对应：默认分组用哨兵，真实分组带前缀，两者不会撞成同一个 id。
  test("放置目标 id 不与真实 space id 混淆", () => {
    expect(toSpaceDropId(null)).toBe(DEFAULT_SPACE_DROP_ID);
    expect(toSpaceDropId("s1")).not.toBe(DEFAULT_SPACE_DROP_ID);
  });

  // 默认分组移到列表最底后，落点判定仍按 id 匹配：顺序变化不得改变任何一条落点语义。
  test("默认分组位置不影响落点判定", () => {
    expect(defaultGroup().spaceId).toBeNull();
    expect(resolveDropTarget("a", DEFAULT_SPACE_DROP_ID, groups())).toEqual({ kind: "unassign" });
    expect(resolveDropTarget("a", toSpaceDropId("s1"), groups())).toBeNull();
    expect(resolveDropTarget("a", toSpaceDropId("s2"), groups())).toEqual({ kind: "assign", spaceId: "s2" });
  });
});

describe("applyAssignmentOverrides 乐观覆盖", () => {
  // 移入：会话先摘出旧分组再落新分组，界面不会出现「同时属于两个分组」的中间态。
  test("移入目标分组并摘出旧分组", () => {
    const overridden = applyAssignmentOverrides(SPACES, new Map([["a", "s2"]]));
    expect(overridden.map((space) => space.sessionIds)).toEqual([[], ["a"]]);
  });

  // 移出（null）：从所有分组里移除，会话落回默认分组（默认分组由 groupBySpace 兜底，不需写入）。
  test("覆盖为 null 时从所有分组移出", () => {
    const overridden = applyAssignmentOverrides(SPACES, new Map([["a", null]]));
    expect(overridden.every((space) => space.sessionIds.length === 0)).toBe(true);
    const grouped = groupBySpace([session("a")], overridden, DEFAULT_LABEL);
    // 移出的会话必须落在渲染顺序最底的那一组（默认分组）。
    expect(grouped[grouped.length - 1].spaceId).toBeNull();
    expect(grouped[grouped.length - 1].sessions.map((item) => item.sessionId)).toEqual(["a"]);
  });

  // 未覆盖的分组按引用原样透出、空覆盖返回同一实例：没有本地覆盖时分组计算不必重算。
  test("空覆盖表返回同一引用", () => {
    const overrides = new Map<string, string | null>();
    expect(applyAssignmentOverrides(SPACES, overrides)).toBe(SPACES);
  });
});

describe("pruneSettledOverrides 覆盖退场", () => {
  // 宿主快照已经体现该写：覆盖退休，此后列表完全跟随宿主，不再被本地状态遮蔽。
  test("快照已体现的覆盖退场", () => {
    const settled = pruneSettledOverrides([{ id: "s2", name: "空间二", sessionIds: ["a"] }], new Map([["a", "s2"]]));
    expect(settled.size).toBe(0);
  });

  // 快照还没追上（写入在途 / 重取失败）：覆盖必须留着，否则界面先跳回旧分组再跳回来。
  test("快照未体现的覆盖保留", () => {
    const overrides = new Map<string, string | null>([["a", "s2"]]);
    expect(pruneSettledOverrides(SPACES, overrides)).toBe(overrides);
  });

  // 移出归属的覆盖同样以「没有任何分组认领它」作为退场条件。
  test("移出覆盖在快照不再认领时退场", () => {
    const settled = pruneSettledOverrides([{ id: "s1", name: "空间一", sessionIds: [] }], new Map([["a", null]]));
    expect(settled.size).toBe(0);
  });

  // 多条覆盖逐条判定：只退场已经对上的那条，其余保留。
  test("按会话逐条退场", () => {
    const overrides = new Map<string, string | null>([
      ["a", "s2"],
      ["b", "s2"],
    ]);
    const settled = pruneSettledOverrides(
      [
        { id: "s1", name: "空间一", sessionIds: [] },
        { id: "s2", name: "空间二", sessionIds: ["a"] },
      ],
      overrides,
    );
    expect([...settled.keys()]).toEqual(["b"]);
  });
});

// 写仍在途时旧快照可能刚好等于最终目标，必须等本次写落定后才允许退场。
test("在途 A→B→A 不被旧 A 快照提前退场", () => {
  const overrides = new Map([["a", "s1"]]);
  expect(pruneSettledOverrides(SPACES, overrides, new Set(["a"]))).toBe(overrides);
  expect(pruneSettledOverrides(SPACES, overrides).size).toBe(0);
});
