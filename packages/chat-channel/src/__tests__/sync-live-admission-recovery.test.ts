import { expect, test } from "bun:test";
import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import type { LiveInput, LiveRecordValue } from "../sync/live/live-writer";
import { createRuntimeDoc, RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { records } from "../sync/live/writer-support";
import { fixture, contentObjectInput as object } from "./sync-live-admission-fixture";

const payload = (record: LiveRecordValue) => JSON.parse(new TextDecoder().decode(record.payload));

// 已提交前缀必须保留，拒绝记录不能污染下一次 update 的 Yjs 依赖。
test("额度拒绝后继续写入仍能从已提交字节完整重建", async () => {
  const f = await fixture();
  await f.writer.accept(object("before"));
  const hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive"));
  try {
    await expect(f.writer.accept(object("rejected"))).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    expect((await f.read()).map(payload)).toEqual([{ value: "before" }]);
    hold.release();
    await f.writer.accept(object("after"));
    expect((await f.read()).map(payload)).toEqual([{ value: "before" }, { value: "after" }]);
  } finally {
    hold.release();
    await f.close();
  }
});

for (const recovery of ["same", "recover", "reopen"] as const) {
  // 已提交的前片即使跨块并重开 writer，也只能保留一次；重试只补未提交片。
  test(`多片对象部分拒绝后 ${recovery} 重试不重复前缀`, async () => {
    const f = await fixture();
    const value = { text: "x".repeat(2 * 1024 * 1024) };
    const input: LiveInput = {
      ...object("large"),
      object: { value, meta: { kind: "history_object", entryId: "large", sourceRevision: 1 } },
    };
    try {
      f.faults.rejectOnAppend = 2;
      await expect(f.writer.accept(input)).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
      expect(await f.readAll()).toHaveLength(1);
      expect(f.store.exportCommittedState().refs).toHaveLength(1);
      f.faults.hold?.release();
      await f.writer.seal();
      if (recovery === "recover") await f.writer.recover();
      if (recovery === "reopen") await f.reopen();
      await f.writer.accept(input);
      const saved = await f.readAll();
      const parts = saved.map(payload);
      expect(saved).toHaveLength(parts[0].partCount);
      expect(new Set(saved.map((record) => record.partIndex)).size).toBe(saved.length);
      expect(JSON.parse(Buffer.concat(parts.map((part) => Buffer.from(part.data, "base64"))).toString())).toEqual(
        value,
      );
      await f.writer.accept(input);
      expect(await f.readAll()).toHaveLength(saved.length);
    } finally {
      await f.close();
    }
  });
}

// 已提交但丢回执的片也有权威定位；重试不能把这一片重复追加。
test("对象分片回执丢失后重试只补未提交片", async () => {
  const f = await fixture();
  const value = { text: "x".repeat(512 * 1024) };
  const input: LiveInput = {
    ...object("reply"),
    object: { value, meta: { kind: "history_object", entryId: "reply" } },
  };
  try {
    f.faults.throwAfterWrite = true;
    await expect(f.writer.accept(input)).rejects.toBe(f.replyError);
    await f.writer.accept(input);
    const saved = await f.readAll();
    expect(saved).toHaveLength(payload(saved[0]).partCount);
    const parts = saved.map(payload);
    expect(parts.map((part) => part.partIndex)).toEqual(Array.from({ length: parts.length }, (_, index) => index));
    expect(JSON.parse(Buffer.concat(parts.map((part) => Buffer.from(part.data, "base64"))).toString())).toEqual(value);
  } finally {
    await f.close();
  }
});

// 缺省槽位与显式零保留原始身份，不同 entry 的同文对象也不能被合并。
test("对象定位保留缺省槽位与独立消息身份", async () => {
  const f = await fixture();
  const value = { text: "same" };
  try {
    for (const meta of [
      { kind: "history_object" as const, entryId: "one" },
      { kind: "history_object" as const, entryId: "one", contentSlot: 0 },
      { kind: "history_object" as const, entryId: "two" },
    ])
      await f.writer.accept({ ...object("identity"), object: { value, meta } });
    expect(await f.readAll()).toHaveLength(3);
    expect(f.store.exportCommittedState().refs).toHaveLength(3);
  } finally {
    await f.close();
  }
});

// 索引不能替代正文校验；读取失败应保留原错，之后仍可重新确认已提交事实。
test("对象定位命中但正文读取失败时不冒充重试成功", async () => {
  const f = await fixture();
  const input = object("read-failure");
  try {
    await f.writer.accept(input);
    f.faults.failReads = true;
    await expect(f.writer.accept(input)).rejects.toThrow("reload unavailable");
    f.faults.failReads = false;
    await f.writer.accept(input);
    expect(await f.readAll()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

// 稳定身份不能在同一修订下换正文，新修订仍可正常写入。
test("对象同身份异正文拒绝但新修订可提交", async () => {
  const f = await fixture();
  const first: LiveInput = {
    ...object("one"),
    object: { value: { text: "one" }, meta: { kind: "history_object", entryId: "one", sourceRevision: 1 } },
  };
  const changed = { ...first, object: { ...first.object!, value: { text: "changed" } } };
  try {
    await f.writer.accept(first);
    await expect(f.writer.accept(changed)).rejects.toMatchObject({ code: "DIGEST_CONFLICT" });
    expect(await f.readAll()).toHaveLength(1);
    await f.writer.accept({
      ...changed,
      object: { ...changed.object, meta: { ...changed.object.meta, sourceRevision: 2 } },
    });
    expect((await f.readAll()).map(payload)).toEqual([{ text: "one" }, { text: "changed" }]);
  } finally {
    await f.close();
  }
});

// 无来源身份的独立小对象保留两份，多片对象必须在提交前获得可重试的稳定身份。
test("匿名对象不按正文去重且多片匿名输入在写入前拒绝", async () => {
  const f = await fixture();
  const input: LiveInput = {
    ...object("anonymous"),
    object: { value: { text: "same" }, meta: { kind: "history_object" } },
  };
  try {
    await f.writer.accept(input);
    await f.writer.accept(input);
    expect(await f.readAll()).toHaveLength(2);
    await expect(
      f.writer.accept({ ...input, object: { ...input.object!, value: { text: "x".repeat(512 * 1024) } } }),
    ).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
    expect(await f.readAll()).toHaveLength(2);
  } finally {
    await f.close();
  }
});

// 同一批修改正文和 runtime 时必须一起恢复，工具边界的去重声明也不能吞掉重试。
test("多文档语义批次拒绝后重试保留工具边界与实体", async () => {
  const f = await fixture();
  const input: LiveInput = {
    kind: "semantic",
    turnId: "turn",
    entryId: "tool-entry",
    contentSlot: "tool",
    contentType: "application/json",
    semantic: {
      kind: "tool",
      payload: {
        entityId: "tool-one",
        toolCallId: "tool-one",
        boundary: true,
        boundaryOrdinal: 0,
        metadata: { title: "tool" },
      },
    },
  };
  const hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive"));
  try {
    await expect(f.writer.accept(input)).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    hold.release();
    await f.writer.accept(input);
    expect((await f.read()).filter((record) => record.kind === "tool_boundary")).toHaveLength(1);
    const committed = await loadCommittedDoc(f.store, f.runtimeId);
    if (!committed) throw new Error("Missing committed runtime");
    try {
      expect(createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS, committed.doc).entityCount()).toBe(1);
    } finally {
      committed.doc.destroy();
    }
  } finally {
    hold.release();
    await f.close();
  }
});

// 回滚读取也失败时必须停写，既保留原始拒绝，又禁止使用尚未恢复的游标再次提交。
test("重载失败保留原始写入错误并阻止后续写入", async () => {
  const f = await fixture();
  const hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive"));
  try {
    f.faults.failReads = true;
    let error: unknown;
    try {
      await f.writer.accept(object("rejected"));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBe(f.faults.writeError);
    expect(error).toMatchObject({ code: "ADMISSION_REJECTED" });
    hold.release();
    const calls = f.faults.appendCalls;
    await expect(f.writer.accept(object("after"))).rejects.toBeInstanceOf(Error);
    expect(f.faults.appendCalls).toBe(calls);
  } finally {
    hold.release();
    await f.close();
  }
});

// 存储已成功但回执丢失时，重载必须包括连续 tail，不能退回旧 base 丢掉已提交前缀。
test("回执丢失后从权威前沿重载并继续写入", async () => {
  const f = await fixture();
  try {
    f.faults.throwAfterWrite = true;
    await expect(f.writer.accept(object("committed"))).rejects.toBe(f.replyError);
    await f.writer.accept(object("after"));
    expect((await f.read()).map(payload)).toEqual([{ value: "committed" }, { value: "after" }]);
  } finally {
    await f.close();
  }
});

// 公开固定批次入口也会先修改游标，不能绕过与普通接收路径相同的拒绝恢复。
test("固定批次提交拒绝后不污染下一次对象写入", async () => {
  const f = await fixture();
  const uncommitted = new Y.Doc({ guid: f.contentId });
  records(uncommitted, [
    {
      recordId: "rejected",
      entryId: "rejected",
      kind: "history_object",
      contentSlot: "object",
      contentType: "application/json",
      partIndex: 0,
      payload: new TextEncoder().encode("{}"),
    },
  ]);
  const update = Y.encodeStateAsUpdate(uncommitted);
  uncommitted.destroy();
  const hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive"));
  try {
    await expect(
      f.writer.commit({
        batchId: "batch_rejected",
        docId: f.contentId,
        ordinalStart: 1,
        ordinalEnd: 1,
        payload: update,
        digest: sha256Digest(update),
      }),
    ).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    hold.release();
    await f.writer.accept(object("after"));
    expect((await f.read()).map(payload)).toEqual([{ value: "after" }]);
  } finally {
    hold.release();
    await f.close();
  }
});

// 内容 successor 尚未进入目录时必须停写，不能确认客户端永远发现不了的新内容。
test("轮换目录登记被拒绝后禁止继续写入 successor", async () => {
  const f = await fixture();
  await f.writer.accept(object("before"));
  const hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive"));
  try {
    await expect(f.writer.seal()).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    hold.release();
    const calls = f.faults.appendCalls;
    await expect(f.writer.accept(object("invisible"))).rejects.toBeInstanceOf(Error);
    expect(f.faults.appendCalls).toBe(calls);
    expect((await f.read()).map(payload)).toEqual([{ value: "before" }]);
  } finally {
    hold.release();
    await f.close();
  }
});

// 后继基线登记被拒时必须停写，活动实体仍由未完成封口的前代持有。
test("runtime 后继基线登记被拒绝后禁止继续写入", async () => {
  const f = await fixture();
  const input: LiveInput = {
    kind: "semantic",
    turnId: "turn",
    entryId: "tool-entry",
    contentSlot: "tool",
    contentType: "application/json",
    semantic: { kind: "tool", payload: { entityId: "tool-one", metadata: { title: "tool" } } },
  };
  await f.writer.accept(input);
  const hold = f.admission.reserve("transportCache", f.admission.available("transportCache"));
  try {
    await expect(f.writer.rotateRuntime()).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    hold.release();
    const calls = f.faults.appendCalls;
    await expect(
      f.writer.accept({ ...input, semantic: { kind: "error", payload: { entityId: "error-two", metadata: {} } } }),
    ).rejects.toBeInstanceOf(Error);
    expect(f.faults.appendCalls).toBe(calls);
    const committed = await loadCommittedDoc(f.store, f.runtimeId);
    if (!committed) throw new Error("Missing old runtime");
    try {
      expect(
        createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS, committed.doc)
          .exportForRotation()
          .map((entity) => entity.entityId),
      ).toEqual(["tool-one"]);
    } finally {
      committed.doc.destroy();
    }
  } finally {
    hold.release();
    await f.close();
  }
});

// getter 只在接纳时读取一次，落库正文必须与指纹绑定的字节相同，重试不得发生身份冲突。
test("单片对象沿用接纳字节且不再次读取原始 getter", async () => {
  const f = await fixture();
  let reads = 0;
  const value = {
    get text() {
      reads++;
      return reads === 1 ? "admitted" : "changed";
    },
  };
  const meta = { kind: "history_object" as const, entryId: "getter" };
  try {
    await f.writer.accept({ ...object("getter"), object: { value, meta } });
    expect(reads).toBe(1);
    expect((await f.readAll()).map(payload)).toEqual([{ text: "admitted" }]);
    await f.writer.accept({ ...object("getter"), object: { value: { text: "admitted" }, meta } });
    expect(await f.readAll()).toHaveLength(1);
  } finally {
    await f.close();
  }
});
