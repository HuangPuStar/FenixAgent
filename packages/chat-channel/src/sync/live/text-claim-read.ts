import * as Y from "yjs";
import type { AdmissionController, Reservation } from "../capacity/admission";
import { SyncProtocolError } from "../protocol/errors";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import type { ProjectionStore } from "../store/types";

/** 覆盖单 Doc 解码结构、一个 tail 更新和编码检查的峰值，不保留多页或多个正文实例。 */
const BODY_READ_BYTES = MAX_DOC_SNAPSHOT_BYTES * 64 + 8192;

/** 单个存储返回值不能借读取页数绕过传输硬限，也不能先交给解码器再判定。 */
function assertBounded(update: Uint8Array): void {
  if (update.byteLength > MAX_DOC_SNAPSHOT_BYTES)
    throw new SyncProtocolError("CAPACITY_EXCEEDED", {
      message: "text claim committed bytes exceed the transport limit",
    });
}

/** 先取共享额度再读取 canonical 与逐条 tail；消费回调仅能带走判定或身份，正文由本函数销毁。 */
export async function readTextClaimDoc<T>(input: {
  readonly store: ProjectionStore;
  readonly admission: AdmissionController;
  readonly docId: string;
  readonly assertCurrent: () => void;
  readonly consume: (doc: Y.Doc, lastSeq: number) => T;
}): Promise<T | null> {
  let body: Reservation | undefined;
  let metadata: Reservation | undefined;
  let doc: Y.Doc | undefined;
  try {
    input.assertCurrent();
    body = input.admission.reserve("hotDocLive", BODY_READ_BYTES);
    metadata = input.admission.reserve("controlIndex", 8192 + input.docId.length * 4);
    const base = await input.store.readDocStateAt(input.docId, 0);
    input.assertCurrent();
    if (base === null) return null;
    assertBounded(base.snapshot);
    doc = new Y.Doc({ guid: input.docId });
    Y.applyUpdate(doc, base.snapshot);
    let encodedUpper = base.snapshot.byteLength;
    let lastSeq = base.lastSeq;
    for (;;) {
      const page = await input.store.readUpdatesAfter(input.docId, lastSeq, 1);
      input.assertCurrent();
      if (page.length > 1)
        throw new SyncProtocolError("MALFORMED_FRAME", { message: "text claim tail exceeded its one-update page" });
      const update = page[0];
      if (!update) return input.consume(doc, lastSeq);
      if (update.updateSeq !== lastSeq + 1)
        throw new SyncProtocolError("SEQUENCE_GAP", { message: "text claim tail is not continuous" });
      assertBounded(update.bytes);
      Y.applyUpdate(doc, update.bytes);
      encodedUpper += update.bytes.byteLength;
      // 重复与删除会高估累计原始字节；临界时用真实编码校准，不能把合法大账本永久拒绝。
      if (encodedUpper > MAX_DOC_SNAPSHOT_BYTES) {
        const snapshot = Y.encodeStateAsUpdate(doc);
        assertBounded(snapshot);
        encodedUpper = snapshot.byteLength;
      }
      lastSeq = update.updateSeq;
    }
  } finally {
    doc?.destroy();
    metadata?.release();
    body?.release();
  }
}
