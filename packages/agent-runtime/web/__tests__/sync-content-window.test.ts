// 内容块驻留有界：窗口只决定保留哪些块，订阅层负责把释放决定落到 retain 计数与投影镜像。

import { expect, test } from "bun:test";
import * as Y from "yjs";
import { createSyncContentSubscription } from "../yjs/sync-content-subscription";
import { createSyncContentWindow } from "../yjs/sync-content-window";
import { createSyncContentProjectionHub } from "../yjs/sync-doc-hub";

// 连续追加不能把订阅集合无限推大：超过驻留预算时按目录顺序释放最旧的已订阅块，并放回“更早”集合。
test("目录追加超过驻留预算时释放最旧的已订阅块", () => {
  const window = createSyncContentWindow({ initialBlocks: 2, maxRetainedBlocks: 4 });
  const initial = window.plan(["a", "b", "c", "d"], new Set(), true);
  expect(initial.retain).toEqual(["c", "d"]);
  expect(initial.release).toEqual([]);

  const next = window.plan(["a", "b", "c", "d", "e", "f", "g", "h"], new Set(["c", "d"]), false);
  expect(next.retain).toEqual(["e", "f", "g", "h"]);
  expect(next.release).toEqual(["c", "d"]);
  expect(next.hasEarlier).toBe(true);
  expect(window.earlierDocIds(["a", "b", "c", "d", "e", "f", "g", "h"])).toEqual(["a", "b", "c", "d"]);
});

// 订阅层必须实际执行窗口的释放裁决：移出 retainedDocs 并调用宿主释放入口，释放后块仍可重新加载。
test("订阅层释放窗口裁决的块并保留重新加载入口", () => {
  const retainedDocs = new Set<string>();
  const released: string[] = [];
  const subscribed: string[][] = [];
  const subscription = createSyncContentSubscription({
    retainedDocs,
    initialBlocks: 2,
    maxRetainedBlocks: 4,
    hydration: { addPending: () => {}, extendInitial: () => {} },
    subscribe: (docIds) => {
      subscribed.push([...docIds]);
      return true;
    },
    retainDoc: () => {},
    releaseDoc: (docId) => released.push(docId),
    onSubscribed: () => {},
    onHistoryState: () => {},
    hiddenMessageCount: () => 0,
    growProjectionWindow: () => {},
    fail: (code, message) => {
      throw new Error(`${code}: ${message}`);
    },
  });

  subscription.applyDirectory(["a", "b", "c", "d"], true);
  expect([...retainedDocs]).toEqual(["c", "d"]);

  subscription.applyDirectory(["a", "b", "c", "d", "e", "f", "g", "h"], false);
  expect(released).toEqual(["c", "d"]);
  expect([...retainedDocs]).toEqual(["e", "f", "g", "h"]);
  expect(subscribed).toEqual([
    ["c", "d"],
    ["e", "f", "g", "h"],
  ]);
  expect(subscription.hasEarlier()).toBe(true);
});

// 释放不是丢弃：被淘汰的块回到更早集合，重新加载时再次订阅；最新块永远保留，回看期间新块仍订阅。
test("释放后的块可重新加载，最新块保留且回看期间新块仍订阅", () => {
  const window = createSyncContentWindow({ initialBlocks: 2, maxRetainedBlocks: 4 });
  const all = ["a", "b", "c", "d", "e", "f", "g", "h"];
  window.plan(all.slice(0, 4), new Set(), true);
  const appended = window.plan(all, new Set(["c", "d"]), false);
  expect(appended.retain).toEqual(["e", "f", "g", "h"]);
  expect(appended.release).toEqual(["c", "d"]);

  const reloaded = window.loadEarlier(all, new Set(["e", "f", "g", "h"]));
  expect(reloaded.retain).toEqual(["a", "b", "c", "d"]);
  // 双向淘汰：向历史扩展时释放除最新块外的已订阅块；h 是 live tail，必须保留。
  expect(reloaded.release).toEqual(["e", "f", "g"]);
  expect(window.laterDocIds(all)).toEqual(["e", "f", "g"]);

  // 用户仍在回看历史：live 追加的新块仍立即订阅（被淘汰的 e/f/g 不会因此复活）。
  const live = window.plan([...all, "i"], new Set(["a", "b", "c", "d", "h"]), false);
  expect(live.retain).toEqual(["i"]);
  expect(window.laterDocIds([...all, "i"])).toEqual(["e", "f", "g"]);
  expect(live.hasEarlier).toBe(true);
});

// 最新 retained 块是流式回复所在块：即使 overflow 大于可释放集合，也只能释放其余块。
test("连续 loadEarlier 永不释放最新 retained 块", () => {
  const window = createSyncContentWindow({ initialBlocks: 1, maxRetainedBlocks: 2 });
  const all = ["a", "b", "c", "d"];
  window.plan(all, new Set(), true);
  expect(window.hasEarlier()).toBe(true);

  const loaded = window.loadEarlier(all, new Set(["d"]));
  expect(loaded.retain).toEqual(["a", "b", "c"]);
  // 除 d 外已无 retained 块：可释放集合为空时允许窗口暂时超预算，不得淘汰 d。
  expect(loaded.release).toEqual([]);
  expect(window.laterDocIds(all)).toEqual([]);
});

// 连续向历史扩展时，release 从“除最新块外”的集合里按目录顺序从后往前取。
test("连续 loadEarlier 只释放除最新块外的已订阅块", () => {
  const window = createSyncContentWindow({ initialBlocks: 2, maxRetainedBlocks: 4 });
  const all = ["a", "b", "c", "d", "e", "f", "g", "h"];
  window.plan(all, new Set(), true);

  const first = window.loadEarlier(all, new Set(["g", "h"]));
  expect(first.release).toEqual(["g"]);

  // 模拟订阅层已订阅 c-f 并淘汰 g，h 仍驻留。
  const second = window.loadEarlier(all, new Set(["c", "d", "e", "f", "h"]));
  expect(second.release).toEqual(["d", "e", "f"]);
  expect(second.release).not.toContain("h");
  expect(window.laterDocIds(all)).toEqual(["d", "e", "f", "g"]);
});

// 回到最新必须有界：只保留目录末尾窗口，中间缺口回到“可加载更早”，不会一次性恢复全部历史。
test("focusLatest 有界定位最新区间并把中间缺口放回更早集合", () => {
  const window = createSyncContentWindow({ initialBlocks: 2, maxRetainedBlocks: 4 });
  const all = ["a", "b", "c", "d", "e", "f", "g", "h"];
  window.plan(all, new Set(), true);
  const loaded = window.loadEarlier(all, new Set(["g", "h"]));
  expect(loaded.release).toEqual(["g"]);

  // 回看期间目录不追加：被淘汰的 g 不会自动订阅。
  const anchored = window.plan(all, new Set(["c", "d", "e", "f", "h"]), false);
  expect(anchored.retain).toEqual([]);

  const focused = window.focusLatest(all, new Set(["c", "d", "e", "f", "h"]));
  expect(focused.retain).toEqual(["g"]);
  expect(focused.release).toEqual(["c", "d", "e", "f"]);
  expect(window.laterDocIds(all)).toEqual([]);
  expect(window.earlierDocIds(all)).toEqual(["a", "b", "c", "d", "e", "f"]);
  expect(focused.hasEarlier).toBe(true);
});

// 20+ 块反复向前/向后翻页：loadEarlier 制造缺口，loadLater 按目录顺序逐批补回，所有块最终可达。
test("20 块以上双向翻页：中间缺口可重新加载且不重复驻留", () => {
  const window = createSyncContentWindow({ initialBlocks: 4, maxRetainedBlocks: 12 });
  const all = Array.from({ length: 24 }, (_, index) => `b${String(index + 1).padStart(2, "0")}`);
  const retained = new Set<string>();
  const apply = (plan: { retain: readonly string[]; release: readonly string[] }): void => {
    for (const docId of plan.retain) retained.add(docId);
    for (const docId of plan.release) retained.delete(docId);
  };

  apply(window.plan(all, retained, true));
  expect([...retained]).toEqual(["b21", "b22", "b23", "b24"]);

  for (let page = 0; page < 5; page += 1) apply(window.loadEarlier(all, retained));
  expect(window.hasLater()).toBe(true);
  expect(window.hasEarlier()).toBe(false);
  // 缺口是 b12–b23；live tail b24 必须始终驻留。
  expect(retained.has("b24")).toBe(true);
  expect(retained).not.toContain("b20");
  expect(window.laterDocIds(all)).toEqual([
    "b12",
    "b13",
    "b14",
    "b15",
    "b16",
    "b17",
    "b18",
    "b19",
    "b20",
    "b21",
    "b22",
    "b23",
  ]);

  const restored: string[] = [];
  while (window.hasLater()) {
    const plan = window.loadLater(all, retained);
    expect(plan.retain.length).toBeGreaterThan(0);
    restored.push(...plan.retain);
    apply(plan);
  }
  expect(restored).toEqual(["b12", "b13", "b14", "b15", "b16", "b17", "b18", "b19", "b20", "b21", "b22", "b23"]);
  expect(window.earlierDocIds(all)).toEqual([
    "b01",
    "b02",
    "b03",
    "b04",
    "b05",
    "b06",
    "b07",
    "b08",
    "b09",
    "b10",
    "b11",
    "b12",
  ]);
  expect(retained.size).toBe(12);
  expect(retained.has("b24")).toBe(true);
});

// 订阅层必须把“回看期间新块仍订阅、返回最新有界恢复”落到实际 retain/SUBSCRIBE 并等待基线。
test("订阅层回看期间仍订阅新块，returnToLatest 只恢复最新窗口并等待基线", async () => {
  const retainedDocs = new Set<string>();
  const released: string[] = [];
  const subscribed: string[][] = [];
  const historyStates: { hasEarlier: boolean; hasLater: boolean; loading: boolean }[] = [];
  const subscription = createSyncContentSubscription({
    retainedDocs,
    initialBlocks: 2,
    maxRetainedBlocks: 4,
    hydration: { addPending: () => {}, extendInitial: () => {} },
    subscribe: (docIds) => {
      subscribed.push([...docIds]);
      return true;
    },
    retainDoc: () => {},
    releaseDoc: (docId) => released.push(docId),
    onSubscribed: () => {},
    onHistoryState: (state) => historyStates.push(state),
    hiddenMessageCount: () => 0,
    growProjectionWindow: () => {},
    fail: (code, message) => {
      throw new Error(`${code}: ${message}`);
    },
  });

  const base = ["a", "b", "c", "d", "e", "f", "g", "h"];
  subscription.applyDirectory(base, true);
  for (const docId of ["g", "h"]) subscription.noteBase(docId);
  expect(retainedDocs.has("g")).toBe(true);
  expect(retainedDocs.has("h")).toBe(true);

  expect(subscription.loadEarlier(base)).toBe(true);
  // 历史批次到达后结束等待，避免测试遗留超时定时器。
  for (const docId of ["c", "d", "e", "f"]) subscription.noteBase(docId);
  expect(released).toEqual(["g"]);
  expect(retainedDocs.has("g")).toBe(false);
  expect(retainedDocs.has("h")).toBe(true);
  expect(historyStates.at(-1)?.hasLater).toBe(true);

  subscription.applyDirectory([...base, "i"], false);
  expect(subscribed.at(-1)).toEqual(["i"]);
  expect(retainedDocs.has("i")).toBe(true);

  const latestReady = subscription.returnToLatest([...base, "i"]);
  expect(subscribed.at(-1)).toEqual(["i"]);
  expect(historyStates.at(-1)?.hasLater).toBe(false);
  expect(subscription.hasLater()).toBe(false);
  // 基线未到前 promise 不得提前完成；到达后才允许渲染层滚动到最新。
  let settled = false;
  void latestReady.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  subscription.noteBase("h");
  subscription.noteBase("i");
  expect(await latestReady).toBe(true);
  subscription.reset();
});

// 受保护的块仍在等待 DOC_BASE：即使最旧且超预算也不得释放，但仍计入预算，让未保护的旧块照常淘汰。
test("protected 块不进入 release 且仍计入驻留预算", () => {
  const window = createSyncContentWindow({ initialBlocks: 2, maxRetainedBlocks: 4 });
  const all = ["a", "b", "c", "d", "e", "f", "g", "h"];
  window.plan(all.slice(0, 4), new Set(), true);

  // 模拟 a-d 均已驻留（a 是等待基线的历史批次），目录追加 e-h：overflow=4，候选只剩 b/c/d。
  const plan = window.plan(all, new Set(["a", "b", "c", "d"]), false, new Set(["a"]));
  expect(plan.retain).toEqual(["e", "f", "g", "h"]);
  expect(plan.release).toEqual(["b", "c", "d"]);
  expect(plan.release).not.toContain("a");
});

// 等待基线的历史块被目录刷新误释放后，后续 DOC_BASE 会被当作未订阅帧丢弃；returnToLatest 必须保护它。
test("等待基线期间 returnToLatest 不释放 pending 块并能在基线到达后结束加载", async () => {
  const retainedDocs = new Set<string>();
  const released: string[] = [];
  const subscribed: string[][] = [];
  const historyStates: { hasEarlier: boolean; hasLater: boolean; loading: boolean }[] = [];
  const subscription = createSyncContentSubscription({
    retainedDocs,
    initialBlocks: 2,
    maxRetainedBlocks: 3,
    hydration: { addPending: () => {}, extendInitial: () => {} },
    subscribe: (docIds) => {
      subscribed.push([...docIds]);
      return true;
    },
    retainDoc: () => {},
    releaseDoc: (docId) => released.push(docId),
    onSubscribed: () => {},
    onHistoryState: (state) => historyStates.push(state),
    hiddenMessageCount: () => 0,
    growProjectionWindow: () => {},
    fail: (code, message) => {
      throw new Error(`${code}: ${message}`);
    },
  });

  const base = ["a", "b", "c"];
  subscription.applyDirectory(base, true);
  expect([...retainedDocs]).toEqual(["b", "c"]);

  // 回看更早历史：a 进入 pending，等待 DOC_BASE 期间 loading=true。
  expect(subscription.loadEarlier(base)).toBe(true);
  expect(retainedDocs.has("a")).toBe(true);
  expect(historyStates.at(-1)?.loading).toBe(true);

  // pending 期间回到最新：只释放未受保护的 b/c，a 必须仍驻留；最新窗口 e/f 需等待基线。
  const latestReady = subscription.returnToLatest([...base, "d", "e", "f"]);
  expect(released).toEqual(["b", "c"]);
  expect(retainedDocs.has("a")).toBe(true);
  expect(subscribed.at(-1)).toEqual(["e", "f"]);
  expect(retainedDocs.has("e") && retainedDocs.has("f")).toBe(true);
  expect(historyStates.at(-1)?.loading).toBe(true);

  // 最新基线到达后 promise 完成；a 仍在等待，loading 不能提前结束。
  subscription.noteBase("e");
  subscription.noteBase("f");
  expect(await latestReady).toBe(true);
  expect(historyStates.at(-1)?.loading).toBe(true);
  subscription.noteBase("a");
  expect(historyStates.at(-1)?.loading).toBe(false);
});

// 投影镜像与协议 retain 是两份驻留：释放必须同时销毁只读镜像，否则 Y.Doc 仍留在内存里。
test("释放 content Doc 镜像后不再计入投影驻留数", () => {
  const projections: number[] = [];
  const hub = createSyncContentProjectionHub({
    onProjection: (projection) => projections.push(projection.contentDocCount),
  });
  const doc = new Y.Doc();
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();

  expect(hub.applyUpdate({ docId: "sync/content/g/0/block", generation: "g", payload: update })).toBe(true);
  expect(hub.snapshot().contentDocCount).toBe(1);
  expect(hub.release("sync/content/g/0/block")).toBe(true);
  expect(hub.snapshot().contentDocCount).toBe(0);
  expect(hub.release("sync/content/g/0/block")).toBe(false);
  hub.dispose();
});
