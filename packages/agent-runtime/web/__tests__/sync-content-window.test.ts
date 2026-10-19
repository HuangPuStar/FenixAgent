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

// 释放不是丢弃：被淘汰的块回到更早集合，重新加载时再次订阅；回看期间新块不自动推走阅读锚点。
test("释放后的块可重新加载，回看历史时新块不自动订阅", () => {
  const window = createSyncContentWindow({ initialBlocks: 2, maxRetainedBlocks: 4 });
  const all = ["a", "b", "c", "d", "e", "f", "g", "h"];
  window.plan(all.slice(0, 4), new Set(), true);
  const appended = window.plan(all, new Set(["c", "d"]), false);
  expect(appended.retain).toEqual(["e", "f", "g", "h"]);
  expect(appended.release).toEqual(["c", "d"]);

  const reloaded = window.loadEarlier(all, new Set(["e", "f", "g", "h"]));
  expect(reloaded.retain).toEqual(["a", "b", "c", "d"]);
  // 双向淘汰：向历史扩展时释放最新的已订阅块，并把它们记入 later。
  expect(reloaded.release).toEqual(["e", "f", "g", "h"]);
  expect(window.laterDocIds(all)).toEqual(["e", "f", "g", "h"]);

  // 用户仍在回看历史：live 追加的块只记录位置，不自动订阅。
  const live = window.plan([...all, "i"], new Set(["a", "b", "c", "d"]), false);
  expect(live.retain).toEqual([]);
  expect(live.hasEarlier).toBe(false);
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
