// packages/agent-runtime/web/__tests__/sync-frame-router.test.ts
// 分页目录旁路：根目录 → 最新页 → 上一页的发现顺序，以及页镜像释放后内容块仍可重新加载。

import { expect, test } from "bun:test";
import {
  buildDirectoryPageSnapshot,
  buildDirectoryRootSnapshot,
  directoryPageDocId,
  directoryRootDocId,
} from "@fenix/chat-channel/sync-client";

import type { SyncContentSubscription } from "../yjs/sync-content-subscription";
import { createSyncFrameRouter } from "../yjs/sync-frame-router";

const GENERATION = "gen_frame_router";
const ROOT_DOC = directoryRootDocId(GENERATION);
const PAGE_1 = directoryPageDocId(GENERATION, 1);
const PAGE_2 = directoryPageDocId(GENERATION, 2);
const PAGE_3 = directoryPageDocId(GENERATION, 3);
const CONTENT_1 = `sync/content/${GENERATION}/1/doc_1`;
const CONTENT_2 = `sync/content/${GENERATION}/2/doc_2`;
const CONTENT_3 = `sync/content/${GENERATION}/3/doc_3`;

function frame(
  type: "DOC_BASE" | "DOC_UPDATE",
  docId: string,
  payload: Uint8Array,
  deliveryId = `${type}:${docId}`,
): Record<string, unknown> {
  return {
    type,
    protocolVersion: 1,
    docId,
    generation: GENERATION,
    transportEpoch: "tx_1",
    subscriptionEpoch: "sub_1",
    syncAttemptId: "att_1",
    deliveryId,
    baseSeq: 0,
    mode: "full",
    payloadDigest: "sha256:test",
    encodedLength: payload.byteLength,
    payload: Buffer.from(payload).toString("base64"),
  };
}

function createHarness() {
  const retainedDocs = new Set<string>();
  const retained: string[] = [];
  const released: string[] = [];
  const subscribed: string[][] = [];
  const directories: string[][] = [];
  const pageLoads: string[][] = [];

  const subscription: SyncContentSubscription = {
    reset(): void {},
    applyDirectory(docIds): void {
      directories.push([...docIds]);
    },
    loadEarlier(): boolean {
      return false;
    },
    loadLater(): boolean {
      return false;
    },
    returnToLatest(): Promise<boolean> {
      return Promise.resolve(false);
    },
    notePageLoaded(docIds): boolean {
      pageLoads.push([...docIds]);
      return false;
    },
    noteBase(): void {},
    refreshHistoryState(): void {},
    hasEarlier(): boolean {
      return false;
    },
    hasLater(): boolean {
      return false;
    },
  };

  const router = createSyncFrameRouter({
    hydration: { noteBase: () => {} },
    getManifest: () => ({ generation: GENERATION, directoryDocId: ROOT_DOC }),
    getContentSubscription: () => subscription,
    retainedDocs,
    retainDoc: (docId) => {
      retained.push(docId);
      retainedDocs.add(docId);
    },
    releaseDoc: (docId) => {
      released.push(docId);
      retainedDocs.delete(docId);
    },
    subscribe: (docIds) => {
      subscribed.push([...docIds]);
      return true;
    },
    fail: (code, message) => {
      throw new Error(`${code}: ${message}`);
    },
  });

  return { router, retainedDocs, retained, released, subscribed, directories, pageLoads };
}

// 根目录只给最新页 ID：客户端先订阅最新页，页到达后才把内容块交给订阅窗口。
test("根目录到达后订阅最新页，页基线揭示内容块", () => {
  const harness = createHarness();
  harness.router.tapDirectoryFrame(frame("DOC_BASE", ROOT_DOC, buildDirectoryRootSnapshot(PAGE_2)));
  expect(harness.retained).toEqual([PAGE_2]);
  expect(harness.subscribed).toEqual([[PAGE_2]]);

  harness.router.tapDirectoryFrame(frame("DOC_BASE", PAGE_2, buildDirectoryPageSnapshot([CONTENT_2], PAGE_1)));
  expect(harness.directories.at(-1)).toEqual([CONTENT_2]);
  expect(harness.pageLoads.at(-1)).toEqual([CONTENT_2]);
  expect(harness.router.readContentDocIds()).toEqual([CONTENT_2]);
  expect(harness.router.hasEarlierPage()).toBe(true);
});

// 更早页按页号合并：先发现的较新页不能把上一页的块排到前面。
test("跨页合并按页号排序，并保留上一页链接", () => {
  const harness = createHarness();
  harness.router.tapDirectoryFrame(frame("DOC_BASE", ROOT_DOC, buildDirectoryRootSnapshot(PAGE_2)));
  harness.router.tapDirectoryFrame(frame("DOC_BASE", PAGE_2, buildDirectoryPageSnapshot([CONTENT_2], PAGE_1)));

  expect(harness.router.requestEarlierPage()).toBe(true);
  expect(harness.subscribed.at(-1)).toEqual([PAGE_1]);
  harness.router.tapDirectoryFrame(frame("DOC_BASE", PAGE_1, buildDirectoryPageSnapshot([CONTENT_1], null)));
  expect(harness.directories.at(-1)).toEqual([CONTENT_1, CONTENT_2]);
  expect(harness.router.hasEarlierPage()).toBe(false);
});

// 页内内容块全部释放后，页镜像可以销毁；页元数据仍保留块列表与更早链接，内容块仍可重新加载。
test("页镜像释放后内容块与更早页入口仍保留", () => {
  const harness = createHarness();
  harness.router.tapDirectoryFrame(frame("DOC_BASE", ROOT_DOC, buildDirectoryRootSnapshot(PAGE_3)));
  harness.router.tapDirectoryFrame(frame("DOC_BASE", PAGE_3, buildDirectoryPageSnapshot([CONTENT_3], PAGE_2)));
  expect(harness.router.hasEarlierPage()).toBe(true);

  expect(harness.router.requestEarlierPage()).toBe(true);
  expect(harness.subscribed.at(-1)).toEqual([PAGE_2]);
  harness.router.tapDirectoryFrame(
    frame("DOC_BASE", PAGE_2, buildDirectoryPageSnapshot([CONTENT_1, CONTENT_2], PAGE_1)),
  );
  expect(harness.router.readContentDocIds()).toEqual([CONTENT_1, CONTENT_2, CONTENT_3]);

  // 页 2 没有驻留内容块且不是最新页：镜像应被释放，但元数据保留。
  harness.router.prunePageMirrors();
  expect(harness.released).toContain(PAGE_2);
  expect(harness.router.readContentDocIds()).toEqual([CONTENT_1, CONTENT_2, CONTENT_3]);
  // 最早已知页仍是页 2，其上一页（页 1）尚未发现：入口保持可请求。
  expect(harness.router.hasEarlierPage()).toBe(true);
  expect(harness.router.requestEarlierPage()).toBe(true);
  expect(harness.subscribed.at(-1)).toEqual([PAGE_1]);
});
