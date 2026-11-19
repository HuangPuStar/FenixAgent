import { expect, test } from "bun:test";
import * as Y from "yjs";
import { analyzeContentUpdate, contentUpdateUsage } from "../sync/store/memory-content-usage";
import {
  EMPTY_RECORD_ID_FILTER,
  mayContainRecordId,
  mergeRecordIdFilters,
} from "../sync/store/memory-record-id-filter";

// 固定小位图即使饱和和碰撞也不能漏掉已见身份，合并不改旧 filter 的不可变值。
test("recordId filter 固定大小且所有已收身份无假阴性", () => {
  const ids = Array.from({ length: 4096 }, (_, index) => `${index}-文本-😀`);
  const first = mergeRecordIdFilters([], ids.slice(0, 2048)),
    second = mergeRecordIdFilters([], ids.slice(2048));
  const combined = mergeRecordIdFilters([first, second]);
  expect(ids.every((id) => mayContainRecordId(combined, id))).toBe(true);
  expect(combined.length).toBe(1024);
  expect(JSON.stringify(combined).length).toBe(1026);
  expect(JSON.stringify(EMPTY_RECORD_ID_FILTER).length).toBe(1026);
  expect(ids.slice(0, 2048).every((id) => mayContainRecordId(first, id))).toBe(true);
});

for (const Content of [Y.ContentAny, Y.ContentJSON, Y.ContentEmbed]) {
  // 非 canonical 根上的各种对象编码同样可能延迟接入，解析必须计入全部潜在 recordId。
  test(`recordId filter 纳入 ${Content.name} 的潜在对象`, () => {
    const doc = new Y.Doc(),
      record = { recordId: "potential", kind: "object_part" };
    try {
      const content = Content === Y.ContentEmbed ? new Y.ContentEmbed(record) : new Content([record]);
      const item = new Y.Item(Y.createID(12345, 0), null, null, null, null, doc.getArray("outside"), null, content);
      const encoder = new Y.UpdateEncoderV1();
      encoder.writeLen(1);
      encoder.writeLen(1);
      encoder.writeClient(12345);
      encoder.writeLen(0);
      item.write(encoder, 0);
      encoder.writeLen(0);
      const bytes = encoder.toUint8Array(),
        delta = analyzeContentUpdate(bytes);
      expect(delta.recordIds).toEqual(["potential"]);
      expect(mayContainRecordId(contentUpdateUsage(bytes).recordIdFilter, "potential")).toBe(true);
    } finally {
      doc.destroy();
    }
  });
}
