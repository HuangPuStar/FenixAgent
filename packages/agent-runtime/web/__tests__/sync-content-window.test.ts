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

// returnToLatest 只清空 later：下一次 plan 会把被历史淘汰的块作为 fresh 重新订阅。
test("returnToLatest 后被历史淘汰的块重新进入 retain", () => {
  const window = createSyncContentWindow({ initialBlocks: 2, maxRetainedBlocks: 4 });
  const all = ["a", "b", "c", "d", "e", "f", "g", "h"];
  window.plan(all, new Set(), true);
  const loaded = window.loadEarlier(all, new Set(["g", "h"]));
  expect(loaded.release).toEqual(["g"]);

  // 回看期间目录不追加：被淘汰的 g 不会自动订阅。
  const anchored = window.plan(all, new Set(["c", "d", "e", "f", "h"]), false);
  expect(anchored.retain).toEqual([]);

  // 模拟订阅层执行 anchored.release（c 被移出驻留集合），然后回到最新位置。
  window.returnToLatest();
  expect(window.laterDocIds(all)).toEqual([]);
  const resumed = window.plan(all, new Set(["d", "e", "f", "h"]), false);
  expect(resumed.retain).toEqual(["g"]);
});

// 订阅层必须把“回看期间新块仍订阅、返回最新后淘汰块重新订阅”落到实际 retain/SUBSCRIBE。
test("订阅层回看期间仍订阅新块，returnToLatest 重新订阅淘汰块", () => {
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

  const base = ["a", "b", "c", "d", "e", "f", "g", "h"];
  subscription.applyDirectory(base, true);
  expect(retainedDocs.has("g")).toBe(true);
  expect(retainedDocs.has("h")).toBe(true);

  expect(subscription.loadEarlier(base)).toBe(true);
  // 历史批次到达后结束等待，避免测试遗留超时定时器。
  for (const docId of ["c", "d", "e", "f"]) subscription.noteBase(docId);
  expect(released).toEqual(["g"]);
  expect(retainedDocs.has("g")).toBe(false);
  expect(retainedDocs.has("h")).toBe(true);

  subscription.applyDirectory([...base, "i"], false);
  expect(subscribed.at(-1)).toEqual(["i"]);
  expect(retainedDocs.has("i")).toBe(true);

  subscription.returnToLatest([...base, "i"]);
  expect(subscribed.at(-1)).toEqual(["g"]);
  expect(retainedDocs.has("g")).toBe(true);
  subscription.reset();
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
