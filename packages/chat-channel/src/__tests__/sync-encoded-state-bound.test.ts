import { expect, test } from "bun:test";
import * as Y from "yjs";
import { createEncodedStateBound, decodeStateUpdate } from "../sync/capacity/encoded-state-bound";

// 插入和删除会拆分原有 packed 结构，含最大 clientID 和代理对时也必须有足够编码余量。
test("扁平混合增量的编码上界覆盖拆分与删除", () => {
  const source = new Y.Doc(),
    target = new Y.Doc();
  source.clientID = Number.MAX_SAFE_INTEGER - 64;
  const bound = createEncodedStateBound(Y.encodeStateAsUpdate(target));
  try {
    for (let i = 0; i < 120; i++) {
      const vector = Y.encodeStateVector(source),
        text = source.getText("text");
      if (i % 3 === 0 && text.length > 2) text.delete(Math.floor(text.length / 2), 1);
      else text.insert(Math.floor(text.length / 2), i % 2 === 0 ? "😀" : "abcd");
      if (i % 7 === 0) source.getMap("metadata").set("value", i);
      const update = Y.encodeStateAsUpdate(source, vector);
      bound.add(update);
      Y.applyUpdate(target, update);
      const actual = Y.encodeStateAsUpdate(target).byteLength;
      expect(actual).toBeLessThanOrEqual(bound.upperBytes);
      bound.calibrate(actual, target);
    }
  } finally {
    source.destroy();
    target.destroy();
  }
});

// pending 删除集稍后会拆分新到的 packed 内容，校准不能提前丢弃它的未来拆分额度。
test("pending 删除集在依赖到达后仍有编码拆分余量", () => {
  const source = new Y.Doc(),
    target = new Y.Doc();
  source.clientID = 12345;
  try {
    source.getArray("packed").push(Array(1000).fill(0));
    const initial = Y.encodeStateAsUpdate(source),
      vector = Y.encodeStateVector(source);
    source.transact(() => {
      for (let i = 999; i > 0; i -= 2) source.getArray("packed").delete(i, 1);
    });
    const deletion = Y.encodeStateAsUpdate(source, vector),
      bound = createEncodedStateBound(Y.encodeStateAsUpdate(target));
    bound.add(deletion);
    Y.applyUpdate(target, deletion);
    expect(target.store.pendingDs).not.toBeNull();
    bound.calibrate(Y.encodeStateAsUpdate(target).byteLength, target);
    bound.add(initial);
    Y.applyUpdate(target, initial);
    expect(Y.encodeStateAsUpdate(target).byteLength).toBeLessThanOrEqual(bound.upperBytes);
  } finally {
    source.destroy();
    target.destroy();
  }
});

// pending 多个中插稍后共同拆分旧项，base 已编码也不意味着所有更新已集成。
test("base 中的 pending 结构激活时不低估旧项拆分", () => {
  const source = new Y.Doc(),
    target = new Y.Doc();
  source.clientID = 12345;
  try {
    source.getArray("packed").push(Array(1000).fill(0));
    const initial = Y.encodeStateAsUpdate(source),
      vector = Y.encodeStateVector(source);
    source.transact(() => {
      for (let i = 999; i > 0; i -= 10) source.getArray("packed").insert(i, [1]);
    });
    const middle = Y.encodeStateAsUpdate(source, vector);
    Y.applyUpdate(target, middle);
    expect(target.store.pendingStructs).not.toBeNull();
    const base = Y.encodeStateAsUpdate(target),
      bound = createEncodedStateBound(base);
    bound.calibrate(base.byteLength, target);
    bound.add(initial);
    Y.applyUpdate(target, initial);
    expect(Y.encodeStateAsUpdate(target).byteLength).toBeLessThanOrEqual(bound.upperBytes);
  } finally {
    source.destroy();
    target.destroy();
  }
});

// Yjs 的 decoded Item 会省略继承的 parentSub，但官方 info 标志仍必须识别 map 替换。
test("继承 parentSub 的 map 写入不能被误认为数组追加", () => {
  const source = new Y.Doc();
  try {
    source.getMap("root").set("records", new Y.Array());
    const base = Y.encodeStateAsUpdate(source),
      vector = Y.encodeStateVector(source);
    source.getMap("root").set("records", new Y.Array());
    const update = Y.encodeStateAsUpdate(source, vector);
    const decoded = decodeStateUpdate(update);
    expect(decoded.mapWrites).toBe(true);
    const bound = createEncodedStateBound(base);
    bound.calibrate(base.byteLength, source);
    bound.add(update, decoded);
    expect(bound.upperBytes).toBe(Number.POSITIVE_INFINITY);
  } finally {
    source.destroy();
  }
});

/** 官方 encoder 构造可继承 parentSub 的真实更新，不提供冗余 map 标志和删除集。 */
function hiddenMapWrite(origin: Y.ID, client = 9007199254740000, clock = 0): Uint8Array {
  const encoder = new Y.UpdateEncoderV1();
  encoder.writeLen(1);
  encoder.writeLen(1);
  encoder.writeClient(client);
  encoder.writeLen(clock);
  encoder.writeInfo(128 | 8);
  encoder.writeLeftID(origin);
  new Y.ContentAny(["replacement"]).write(encoder, 0);
  encoder.writeLen(0);
  return encoder.toUint8Array();
}

// 冗余 map 位可省略，标准 wrapper 的隐藏继承引用仍不能走纯追加大小证明。
test("单 wrapper 的隐藏 parentSub 替换必须精确检查", () => {
  const doc = new Y.Doc();
  try {
    const array = new Y.Array();
    array.push([1, 2, 3]);
    doc.getMap("root").set("records", array);
    const base = Y.encodeStateAsUpdate(doc),
      bound = createEncodedStateBound(base);
    bound.calibrate(base.length, doc);
    const update = hiddenMapWrite(array._item!.id);
    expect(decodeStateUpdate(update).mapWrites).toBe(false);
    bound.add(update);
    expect(bound.upperBytes).toBe(Number.POSITIVE_INFINITY);
    Y.applyUpdate(doc, update);
    expect(doc.getMap("root").get("records")).toBe("replacement");
  } finally {
    doc.destroy();
  }
});

// 多次空 wrapper 替换可合并删除历史，packed tombstone 不能冒充唯一正常 map 项。
test("历史多 wrapper 合并删除后隐藏引用仍保持保守", () => {
  const doc = new Y.Doc();
  doc.clientID = 12345;
  try {
    for (let i = 0; i < 3; i++) doc.getMap("root").set("records", new Y.Array());
    expect(
      [...doc.store.clients.values()].flat().some((item) => item instanceof Y.Item && item.deleted && item.length > 1),
    ).toBe(true);
    const base = Y.encodeStateAsUpdate(doc),
      bound = createEncodedStateBound(base);
    bound.calibrate(base.length, doc);
    const update = hiddenMapWrite(Y.createID(12345, 1));
    bound.add(update);
    expect(bound.upperBytes).toBe(Number.POSITIVE_INFINITY);
    Y.applyUpdate(doc, update);
    expect(doc.getMap("root").get("records")).toBe("replacement");
  } finally {
    doc.destroy();
  }
});

// 缺失本 client 前缀时，隐藏 map 项会 pending；编码校准不能抹掉随后激活的未知性。
test("pending 隐藏 parentSub 激活前不释放不确定状态", () => {
  const doc = new Y.Doc(),
    prefix = new Y.Doc();
  doc.clientID = 12345;
  prefix.clientID = 67890;
  try {
    const array = new Y.Array();
    array.push([1]);
    doc.getMap("root").set("records", array);
    const base = Y.encodeStateAsUpdate(doc),
      bound = createEncodedStateBound(base);
    bound.calibrate(base.length, doc);
    const hidden = hiddenMapWrite(array._item!.id, 67890, 1);
    bound.add(hidden);
    Y.applyUpdate(doc, hidden);
    expect(doc.store.pendingStructs).not.toBeNull();
    bound.calibrate(Y.encodeStateAsUpdate(doc).length, doc);
    expect(bound.upperBytes).toBe(Number.POSITIVE_INFINITY);
    prefix.getArray("other").push([0]);
    const update = Y.encodeStateAsUpdate(prefix);
    bound.add(update);
    Y.applyUpdate(doc, update);
    expect(doc.getMap("root").get("records")).toBe("replacement");
  } finally {
    doc.destroy();
    prefix.destroy();
  }
});
