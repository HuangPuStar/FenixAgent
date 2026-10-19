// packages/agent-runtime/web/yjs/sync-frame-router.ts
// 目录 Doc 旁路：把 DOC_BASE/DOC_UPDATE 应用到只读目录镜像，并把 contentDocIds 交给订阅窗口。
//
// 与 transport 分离的原因：目录镜像只负责「字节 → 权威块列表」，不参与握手、重连与 ACK；
// 独立后 transport 不持有 directoryDoc 生命周期，窗口裁决也只经 SyncContentSubscription 一个出口。

import * as Y from "yjs";
import type { SyncContentSubscription } from "./sync-content-subscription";
import { parseContentDocId } from "./sync-doc-hub";
import type { SyncHydrationTracker } from "./sync-hydration-tracker";
import { decodeSyncBase64Payload } from "./yjs-ws";

interface ManifestDirectoryRef {
  readonly generation: string;
  readonly directoryDocId: string;
}

export interface SyncFrameRouterDeps {
  readonly hydration: Pick<SyncHydrationTracker, "noteBase">;
  readonly getManifest: () => ManifestDirectoryRef | null;
  readonly getContentSubscription: () => SyncContentSubscription | null;
  readonly fail: (code: string, message: string) => void;
}

export interface SyncFrameRouter {
  /** 旁路入口；非目录帧、异代次与坏载荷静默忽略。 */
  tapDirectoryFrame(frame: Record<string, unknown>): void;
  /** 当前目录声明的全部内容块（目录顺序）。 */
  readContentDocIds(): string[];
  /** MANIFEST/换代：丢弃旧目录镜像。 */
  resetDirectory(): void;
  dispose(): void;
}

export function createSyncFrameRouter(deps: SyncFrameRouterDeps): SyncFrameRouter {
  let directoryDoc: Y.Doc | null = null;

  function readContentDocIds(): string[] {
    const value = directoryDoc?.getMap<unknown>("root").get("contentDocIds");
    if (value instanceof Y.Array) {
      return value.toArray().filter((docId): docId is string => typeof docId === "string");
    }
    return Array.isArray(value) ? value.filter((docId): docId is string => typeof docId === "string") : [];
  }

  return {
    tapDirectoryFrame(frame): void {
      const activeManifest = deps.getManifest();
      if (
        activeManifest === null ||
        (frame.type !== "DOC_BASE" && frame.type !== "DOC_UPDATE") ||
        frame.docId !== activeManifest.directoryDocId ||
        frame.generation !== activeManifest.generation ||
        typeof frame.payload !== "string"
      ) {
        return;
      }
      const isBase = frame.type === "DOC_BASE";
      const deliveryId = typeof frame.deliveryId === "string" ? frame.deliveryId : null;
      const payload = decodeSyncBase64Payload(frame.payload);
      if (payload === null) return;
      try {
        if (directoryDoc === null) directoryDoc = new Y.Doc();
        Y.applyUpdate(directoryDoc, payload);
        const contentDocIds = readContentDocIds().filter(
          (docId) => parseContentDocId(docId)?.generation === activeManifest.generation,
        );
        if (contentDocIds.length > 0) {
          deps.getContentSubscription()?.applyDirectory(contentDocIds, isBase);
        }
        if (isBase) deps.hydration.noteBase(frame.docId, deliveryId);
      } catch (error) {
        deps.fail("MALFORMED_FRAME", error instanceof Error ? error.message : "failed to apply directory update");
      }
    },

    readContentDocIds,

    resetDirectory(): void {
      directoryDoc?.destroy();
      directoryDoc = new Y.Doc();
    },

    dispose(): void {
      directoryDoc?.destroy();
      directoryDoc = null;
    },
  };
}
