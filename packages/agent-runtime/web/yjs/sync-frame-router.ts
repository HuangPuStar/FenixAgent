// packages/agent-runtime/web/yjs/sync-frame-router.ts
// 分页目录旁路：把根目录 / 页目录的 DOC_BASE/DOC_UPDATE 应用到只读镜像，并向订阅窗口交付
// 「已发现的全部内容块（目录顺序）」与「是否还有更早页」。
//
// 为什么分页：根目录只持最新页 ID（O(1)），每页最多 `DIRECTORY_PAGE_SIZE` 条并链接上一页；
// 客户端先订阅 MANIFEST 的根目录，再按 `latestPageId` 订阅最新页；用户要求更早历史时
// 沿 `previousPageId` 逐页向前订阅。页 Doc 复用既有 DOC_BASE/SUBSCRIBE 协议，无需新增帧。
//
// 页镜像的释放只丢弃 Y.Doc 与协议 retain，页的元数据（内容块列表 + previousPageId）保留：
// 内容块被窗口淘汰后仍能凭这份元数据重新加载，同时不会因为长期阅读历史而无界驻留页副本。

import {
  type DirectoryPageState,
  parseDocId,
  readDirectoryPage,
  readDirectoryRoot,
} from "@fenix/chat-channel/sync-client";
import * as Y from "yjs";

import type { SyncContentSubscription } from "./sync-content-subscription";
import type { SyncHydrationTracker } from "./sync-hydration-tracker";
import { decodeSyncBase64Payload } from "./yjs-ws";

type SubscribePriority = "live" | "currentHistory";

interface ManifestDirectoryRef {
  readonly generation: string;
  readonly directoryDocId: string;
}

export interface SyncFrameRouterDeps {
  readonly hydration: Pick<SyncHydrationTracker, "noteBase">;
  readonly getManifest: () => ManifestDirectoryRef | null;
  readonly getContentSubscription: () => SyncContentSubscription | null;
  /** 已 retain 的内容块；页镜像裁剪以此判断页内是否仍有驻留块。 */
  readonly retainedDocs: ReadonlySet<string>;
  /** retain 一个 Doc 并加入共享集合；失败时抛错由本模块转成协议错误。 */
  readonly retainDoc: (docId: string) => void;
  /** 释放一个 Doc 的协议 retain 与投影镜像；幂等。 */
  readonly releaseDoc: (docId: string) => void;
  readonly subscribe: (docIds: readonly string[], priority: SubscribePriority) => boolean;
  readonly fail: (code: string, message: string) => void;
}

export interface SyncFrameRouter {
  /** 旁路入口；非目录帧、异代次与坏载荷静默忽略。 */
  tapDirectoryFrame(frame: Record<string, unknown>): void;
  /** 已发现的全部内容块（跨页、目录顺序，含已释放页的块）；用于加载更早。 */
  readContentDocIds(): string[];
  /** 最早已知页是否还有未发现的上一页。 */
  hasEarlierPage(): boolean;
  /** 订阅最早已知页的上一页；用户显式加载更早历史时调用。 */
  requestEarlierPage(): boolean;
  /** 释放不再被窗口需要的页镜像（保留页元数据）。 */
  prunePageMirrors(): void;
  /** MANIFEST/换代：丢弃旧目录镜像。 */
  resetDirectory(): void;
  dispose(): void;
}

interface PageMirror {
  readonly pageNumber: number;
  readonly docId: string;
  doc: Y.Doc | null;
  contentDocIds: string[];
  previousPageId: string | null;
  /** 已发出订阅但基线未到：裁剪时不得释放，否则请求永远等不到页。 */
  awaitingBase: boolean;
}

export function createSyncFrameRouter(deps: SyncFrameRouterDeps): SyncFrameRouter {
  let rootDoc: Y.Doc | null = null;
  let rootGeneration: string | null = null;
  let latestPageId: string | null = null;
  const pages = new Map<number, PageMirror>();
  const retainedPages = new Set<string>();
  let discoveredContentDocIds: string[] = [];

  function rebuildDiscoveredContentDocIds(): void {
    const ordered = [...pages.values()].sort((left, right) => left.pageNumber - right.pageNumber);
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const page of ordered) {
      for (const docId of page.contentDocIds) {
        if (seen.has(docId)) continue;
        seen.add(docId);
        merged.push(docId);
      }
    }
    discoveredContentDocIds = merged;
  }

  function pageNumberOf(docId: string): number | null {
    try {
      const parsed = parseDocId(docId);
      return parsed.kind === "directory" ? parsed.blockIndex : null;
    } catch {
      return null;
    }
  }

  function releasePageMirror(page: PageMirror): void {
    if (page.doc === null) return;
    page.doc.destroy();
    page.doc = null;
    page.awaitingBase = false;
    retainedPages.delete(page.docId);
    deps.releaseDoc(page.docId);
  }

  function requestPage(docId: string, priority: SubscribePriority): boolean {
    const alreadyRetained = retainedPages.has(docId);
    if (!alreadyRetained) {
      try {
        deps.retainDoc(docId);
      } catch (error) {
        deps.fail("MALFORMED_FRAME", error instanceof Error ? error.message : "failed to retain directory page");
        return false;
      }
      retainedPages.add(docId);
    }
    const pageNumber = pageNumberOf(docId);
    if (pageNumber !== null) {
      const mirror = pages.get(pageNumber);
      if (mirror !== undefined) mirror.awaitingBase = true;
    }
    // 已 retain 的页也允许重发 SUBSCRIBE：页基线超时后用户再次点击时，仅重试 retain 不会产生新请求。
    if (!deps.subscribe([docId], priority)) {
      if (!alreadyRetained) {
        retainedPages.delete(docId);
        deps.releaseDoc(docId);
      }
      deps.fail("CAPACITY_EXCEEDED", "socket is saturated while sending directory page SUBSCRIBE");
      return false;
    }
    return true;
  }

  function ensurePageMirror(pageNumber: number, docId: string): PageMirror {
    let page = pages.get(pageNumber);
    if (page === undefined) {
      page = { pageNumber, docId, doc: null, contentDocIds: [], previousPageId: null, awaitingBase: false };
      pages.set(pageNumber, page);
    }
    return page;
  }

  function applyPageState(page: PageMirror, state: DirectoryPageState): void {
    page.contentDocIds = [...state.contentDocIds];
    page.previousPageId = state.previousPageId;
    rebuildDiscoveredContentDocIds();
  }

  function applyDirectory(isBase: boolean): void {
    const subscription = deps.getContentSubscription();
    if (subscription === null) return;
    subscription.applyDirectory(discoveredContentDocIds, isBase);
  }

  function tapRootFrame(payload: Uint8Array, isBase: boolean, deliveryId: string | null): void {
    const manifest = deps.getManifest();
    if (manifest === null) return;
    if (rootDoc === null || rootGeneration !== manifest.generation) {
      rootDoc?.destroy();
      rootDoc = new Y.Doc();
      rootGeneration = manifest.generation;
    }
    Y.applyUpdate(rootDoc, payload);
    const root = readDirectoryRoot(rootDoc);
    if (root.latestPageId !== null && root.latestPageId !== latestPageId) {
      latestPageId = root.latestPageId;
      const pageNumber = pageNumberOf(root.latestPageId);
      if (pageNumber !== null) {
        ensurePageMirror(pageNumber, root.latestPageId);
        requestPage(root.latestPageId, "live");
      }
    }
    applyDirectory(isBase);
    if (isBase) deps.hydration.noteBase(manifest.directoryDocId, deliveryId);
  }

  function tapPageFrame(docId: string, payload: Uint8Array, isBase: boolean): void {
    const manifest = deps.getManifest();
    if (manifest === null) return;
    const parsed = parseDocId(docId);
    if (parsed.kind !== "directory" || parsed.generation !== manifest.generation || parsed.blockIndex < 1) return;
    // 未订阅的页帧（已释放页的在途帧）不重建镜像，避免释放后又被帧拉回常驻。
    if (!retainedPages.has(docId) && docId !== latestPageId) return;

    const page = ensurePageMirror(parsed.blockIndex, docId);
    if (page.doc === null) page.doc = new Y.Doc();
    Y.applyUpdate(page.doc, payload);
    applyPageState(page, readDirectoryPage(page.doc));
    if (isBase) page.awaitingBase = false;
    applyDirectory(isBase);
    if (isBase) deps.getContentSubscription()?.notePageLoaded(discoveredContentDocIds);
    prunePageMirrors();
  }

  function prunePageMirrors(): void {
    for (const page of pages.values()) {
      if (page.doc === null || page.awaitingBase) continue;
      if (page.docId === latestPageId) continue;
      if (page.contentDocIds.some((docId) => deps.retainedDocs.has(docId))) continue;
      releasePageMirror(page);
    }
  }

  function earliestPage(): PageMirror | undefined {
    let earliest: PageMirror | undefined;
    for (const page of pages.values()) {
      if (earliest === undefined || page.pageNumber < earliest.pageNumber) earliest = page;
    }
    return earliest;
  }

  function resetDirectory(): void {
    rootDoc?.destroy();
    rootDoc = null;
    rootGeneration = null;
    latestPageId = null;
    for (const page of pages.values()) {
      page.doc?.destroy();
      page.doc = null;
    }
    pages.clear();
    retainedPages.clear();
    discoveredContentDocIds = [];
  }

  return {
    tapDirectoryFrame(frame): void {
      const manifest = deps.getManifest();
      if (
        manifest === null ||
        (frame.type !== "DOC_BASE" && frame.type !== "DOC_UPDATE") ||
        frame.generation !== manifest.generation ||
        typeof frame.docId !== "string" ||
        typeof frame.payload !== "string"
      ) {
        return;
      }
      const isBase = frame.type === "DOC_BASE";
      const deliveryId = typeof frame.deliveryId === "string" ? frame.deliveryId : null;
      const payload = decodeSyncBase64Payload(frame.payload);
      if (payload === null) return;
      try {
        if (frame.docId === manifest.directoryDocId) {
          tapRootFrame(payload, isBase, deliveryId);
          return;
        }
        tapPageFrame(frame.docId, payload, isBase);
      } catch (error) {
        deps.fail("MALFORMED_FRAME", error instanceof Error ? error.message : "failed to apply directory update");
      }
    },

    readContentDocIds(): string[] {
      return [...discoveredContentDocIds];
    },

    hasEarlierPage(): boolean {
      const earliest = earliestPage();
      if (earliest === undefined || earliest.previousPageId === null) return false;
      const previousNumber = pageNumberOf(earliest.previousPageId);
      return previousNumber !== null && !pages.has(previousNumber);
    },

    requestEarlierPage(): boolean {
      const earliest = earliestPage();
      if (earliest === undefined || earliest.previousPageId === null) return false;
      return requestPage(earliest.previousPageId, "currentHistory");
    },

    prunePageMirrors,

    resetDirectory,

    dispose(): void {
      resetDirectory();
    },
  };
}
