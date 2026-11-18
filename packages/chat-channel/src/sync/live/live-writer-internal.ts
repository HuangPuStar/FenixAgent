import { contentDocOverflow } from "../capacity/content-doc-limits";
// packages/chat-channel/src/sync/live/live-writer-internal.ts
// 实时写者的内部类型与常量（从 live-writer.ts 拆出，非公开 API）。

import * as Y from "yjs";
import type { SyncCapacityProfile } from "../capacity/profile";
import { type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import type { DocKind } from "../protocol/identity";
import type { DocFrontier, SyncRefRecord } from "../store/types";

export const CONTENT_KIND: DocKind = "content";
export const RUNTIME_KIND: DocKind = "runtime";
export const NOOP = (): void => {};

export function fail(code: SyncErrorCode, message: string): never {
  throw new SyncProtocolError(code, { message });
}

/** 显式标注类型才会让调用点之后被收窄：无注解的 `never` 箭头函数不参与控制流分析。 */
export const malformed: (message: string) => never = (message) => fail("MALFORMED_FRAME", message);

export type Identity = { readonly entryId: string; readonly contentSlot: string; readonly contentType?: string };
export type Cursor = { readonly docId: string; readonly kind: DocKind; doc: Y.Doc; lastSeq: number };
export type Slice = { readonly docId: string; readonly fromSeq: number; readonly bytes: Uint8Array };
export type Batch = {
  readonly batchId: string;
  readonly digest: string;
  readonly slices: readonly Slice[];
  readonly refs?: SyncRefRecord[];
};
export type Probe =
  | { readonly status: "committed"; readonly frontiers: DocFrontier[] }
  | { readonly status: "absent" | "ambiguous" };

/** 内容与运行态写入使用各自的硬限制，正文与 Store 共用同一判据。 */
export function overflowOfSlices(input: {
  readonly slices: readonly Slice[];
  readonly recordBytes: number;
  readonly capacity: SyncCapacityProfile;
  readonly runtimeHardLimitBytes: number;
  readonly cursorOf: (docId: string) => Cursor;
}): string | null {
  const chunkLimit = input.capacity.inputs.payloadChunkMaxBytes;
  if (input.recordBytes > chunkLimit) {
    return `record payload is ${input.recordBytes} bytes, chunk limit is ${chunkLimit}`;
  }
  for (const { docId } of input.slices) {
    const cursor = input.cursorOf(docId);
    const size = Y.encodeStateAsUpdate(cursor.doc).byteLength;
    if (cursor.kind === CONTENT_KIND) {
      const overflow = contentDocOverflow({
        doc: cursor.doc,
        capacity: input.capacity,
        lastSeq: cursor.lastSeq + input.slices.filter((slice) => slice.docId === docId).length,
      });
      if (overflow) return overflow;
    } else if (size > input.runtimeHardLimitBytes) return `snapshot of ${docId} exceeds runtime hard limit`;
  }
  return null;
}
