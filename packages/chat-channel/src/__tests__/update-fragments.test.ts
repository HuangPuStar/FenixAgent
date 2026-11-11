import { afterEach, expect, test } from "bun:test";
import {
  decodeYjsSyncFrame,
  encodeYjsFragmentFrame,
  MAX_YJS_SYNC_PAYLOAD_BYTES,
  MAX_YJS_TRANSFER_BYTES,
  YJS_FRAGMENT_DATA_BYTES,
  type YjsFragmentFrame,
} from "../protocol/update-frame";
import { YjsFragmentReceiver } from "../transport/update-fragments";

const receivers: YjsFragmentReceiver[] = [];

// 普通载荷恢复 8 MiB 上限，分片载荷独立限制为 2 MiB，避免两种限制互相牵连。
test("普通载荷上限为 8 MiB，分片头及数据合计最多 2 MiB", () => {
  expect(MAX_YJS_SYNC_PAYLOAD_BYTES).toBe(8 * 1024 * 1024);
  expect(YJS_FRAGMENT_DATA_BYTES + 45).toBe(2 * 1024 * 1024);
});
afterEach(() => {
  for (const receiver of receivers.splice(0)) receiver.reset();
});

function receiver(): YjsFragmentReceiver {
  const value = new YjsFragmentReceiver(() => {});
  receivers.push(value);
  return value;
}

function fragment(offset = 0, overrides: Partial<YjsFragmentFrame> = {}): YjsFragmentFrame {
  const totalBytes = 2 * MAX_YJS_SYNC_PAYLOAD_BYTES;
  return {
    type: "fragment",
    docName: "chat:rcs-boundary",
    generation: "gen-one",
    kind: "update",
    transferId: "00000000-0000-0000-0000-000000000001",
    offset,
    totalBytes,
    chunk: new Uint8Array(Math.min(YJS_FRAGMENT_DATA_BYTES, totalBytes - offset)).fill(7),
    ...overrides,
  };
}

// 字节片段不可单独用于 Yjs，只有最后一片后才交付完整逻辑更新。
test("分片编码无损往返且完整重组前不交付", () => {
  const target = receiver();
  let complete: ReturnType<YjsFragmentReceiver["accept"]> = null;
  for (let offset = 0; offset < 2 * MAX_YJS_SYNC_PAYLOAD_BYTES; offset += YJS_FRAGMENT_DATA_BYTES) {
    const input = fragment(offset);
    const decoded = decodeYjsSyncFrame(encodeYjsFragmentFrame(input));
    expect(decoded?.type).toBe("fragment");
    if (decoded?.type !== "fragment") throw new Error("fragment expected");
    complete = target.accept(decoded);
    expect(complete !== null).toBe(offset + input.chunk.length === input.totalBytes);
  }
  expect(complete?.update.length).toBe(2 * MAX_YJS_SYNC_PAYLOAD_BYTES);
  expect(complete?.update.every((byte) => byte === 7)).toBe(true);
  expect(target.hasPending("chat:rcs-boundary")).toBe(false);
});

// 缺片、重复与跨代混片都应失败，不能拼出伪完整更新。
test("拒绝乱序、重复和混合 generation 的片段", () => {
  const target = receiver();
  expect(() => target.accept(fragment(YJS_FRAGMENT_DATA_BYTES))).toThrow("offset invalid");
  target.accept(fragment());
  expect(() => target.accept(fragment())).toThrow("sequence invalid");
  expect(() => target.accept(fragment(YJS_FRAGMENT_DATA_BYTES, { generation: "gen-other" }))).toThrow(
    "sequence invalid",
  );
  expect(() => target.accept(fragment(YJS_FRAGMENT_DATA_BYTES, { transferId: crypto.randomUUID() }))).toThrow(
    "sequence invalid",
  );
});

// 多文档共享连接的内存预算，关闭或换代后应立即可供新传输使用。
test("累计预算有界并在清理后归还", () => {
  const target = receiver();
  target.accept(fragment(0, { totalBytes: MAX_YJS_TRANSFER_BYTES }));
  expect(() => target.accept(fragment(0, { docName: "session:rcs-boundary" }))).toThrow("budget");
  target.reset();
  expect(() => target.accept(fragment(0, { docName: "session:rcs-boundary" }))).not.toThrow();
  expect(target.hasPending("chat:rcs-boundary")).toBe(false);
});

// 新权威 replace 取消半成品旧传输，两代数据不得合并。
test("换代 replace 取消旧组装", () => {
  const target = receiver();
  target.accept(fragment());
  target.accept(fragment(0, { kind: "replace", generation: "gen-new" }));
  expect(target.hasPending("chat:rcs-boundary", "gen-one")).toBe(false);
  expect(target.hasPending("chat:rcs-boundary", "gen-new")).toBe(true);
});

// 无效尺寸必须在编码及内存分配前拒绝，截断的元数据不能作为合法分片。
test("拒绝越界、截断和偏移错误的分片", () => {
  expect(() => encodeYjsFragmentFrame(fragment(0, { totalBytes: MAX_YJS_TRANSFER_BYTES + 1 }))).toThrow();
  expect(() => encodeYjsFragmentFrame(fragment(1))).toThrow();
  const frame = encodeYjsFragmentFrame(fragment());
  expect(decodeYjsSyncFrame(frame.subarray(0, frame.length - 1))).toBeNull();
});
