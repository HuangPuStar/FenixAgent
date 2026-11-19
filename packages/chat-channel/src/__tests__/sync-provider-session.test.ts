// provider握手、订阅、base、ACK、resync与换代的可观察行为。
import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import { SyncProtocolError } from "../sync/protocol/errors";
import {
  decodeSyncFrame,
  encodeSyncFrame,
  MAX_FRAME_HEADER_BYTES,
  SYNC_PROTOCOL_VERSION,
  type SyncFrame,
} from "../sync/protocol/frames";
import type { OutboundFrame } from "../sync/provider/session";
import {
  appendText,
  commitNextGeneration,
  fillWindow,
  GENERATION,
  handshakeRequest,
  makeHarness,
  NEXT_GENERATION,
  releaseWindow,
  SCOPE,
  seed,
  subscribeRequest,
} from "./sync-provider-session-fixture";

/** 每个出站帧都必须原样过一遍帧层编解码：字段缺失、越界或非法 base64 会在编码阶段直接抛错。 */
function roundTrip(frames: readonly OutboundFrame[]): SyncFrame[] {
  return frames.map((item) => decodeSyncFrame(encodeSyncFrame(item.frame)));
}

function typesOf(frames: readonly OutboundFrame[]): string[] {
  return roundTrip(frames).map((frame) => frame.type);
}

/** 取指定类型的帧：判别字段已由往返编解码验证，类型在这里收窄到对应成员。 */
function frameOf<T extends SyncFrame["type"]>(
  frames: readonly OutboundFrame[],
  type: T,
): Extract<SyncFrame, { type: T }> {
  const matched = roundTrip(frames).find((frame) => frame.type === type);
  if (matched === undefined) throw new Error(`frame ${type} is missing`);
  return matched as Extract<SyncFrame, { type: T }>;
}

/** 把 base 与 tail 载荷应用到空文档，验证客户端重建出的状态与服务端一致。 */
function rebuildFrom(basePayload: string, updatePayloads: readonly string[]): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(basePayload, "base64")));
  for (const payload of updatePayloads) Y.applyUpdate(doc, new Uint8Array(Buffer.from(payload, "base64")));
  return doc;
}

/** 断言调用以指定协议码失败：错误码是稳定契约，消息文本不是。 */
async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof SyncProtocolError) return error.code;
    throw error;
  }
  throw new Error("expected a SyncProtocolError");
}

describe("provider session", () => {
  // 收紧档位前的大 base 不能在零占用窗口里永远重试，须明确失败并收口连接。
  test("旧完整 base 大于新窗口时明确拒绝且后续 tick 不再编码", async () => {
    const seeded = await seed(["z".repeat(64 * 1024)]);
    const harness = makeHarness(seeded.store);
    try {
      await harness.session.handshake(handshakeRequest());
      await expect(harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId))).rejects.toMatchObject({
        code: "CAPACITY_EXCEEDED",
      });
      expect(harness.session.state).toBe("closed");
      const planned = harness.planCalls();
      expect(planned).toBe(1);
      expect(await harness.session.tick()).toEqual([]);
      expect(await harness.session.tick()).toEqual([]);
      expect(harness.planCalls()).toBe(planned);
      expect(harness.quota.snapshot().outstandingBytes).toBe(0);
      expect(harness.ledger.outstandingCount()).toBe(0);
    } finally {
      harness.session.close();
      seeded.serverDoc.destroy();
      seeded.store.dispose();
    }
  });
  // 握手只产出 HELLO 与 MANIFEST 两条控制帧：入口、修订与恢复状态齐备，历史正文一律留给订阅阶段。
  test("handshake 产出 HELLO 回执与 MANIFEST 入口，不携带全历史正文", async () => {
    const seeded = await seed(["marker".repeat(1_500)]);
    const harness = makeHarness(seeded.store);
    expect(harness.session.state).toBe("handshaking");
    const frames = await harness.session.handshake(
      handshakeRequest({
        loadedDocs: [{ docId: seeded.refs.runtimeDocId, stateVector: Y.encodeStateVector(seeded.serverDoc) }],
      }),
    );
    expect(typesOf(frames)).toEqual(["HELLO", "MANIFEST"]);
    const hello = frameOf(frames, "HELLO");
    expect([hello.scope, hello.generation, hello.stateful]).toEqual([SCOPE, GENERATION, true]);
    expect(hello.loadedDocs.map((doc) => doc.docId)).toEqual([seeded.refs.runtimeDocId]);
    const manifest = frameOf(frames, "MANIFEST");
    expect([manifest.generation, manifest.pointerRevision, manifest.referenceRevision]).toEqual([GENERATION, 1, 1]);
    expect([manifest.recoveryState, manifest.controlDocId, manifest.directoryDocId, manifest.runtimeDocId]).toEqual([
      "ready",
      seeded.refs.controlDocId,
      seeded.refs.directoryDocId,
      seeded.refs.runtimeDocId,
    ]);
    // 已提交历史远大于帧头预算：MANIFEST 仍落在头预算内，正文没有被塞进握手。
    expect(encodeSyncFrame(manifest).length).toBeLessThanOrEqual(MAX_FRAME_HEADER_BYTES);
    expect([harness.session.state, harness.planCalls()]).toEqual(["ready", 0]);
  });

  // 零额度连接只保留「还要发什么」的有界任务引用：不构建 base、不产出编码帧，也不报错。
  test("零额度订阅只保留有界任务引用，额度归还后由 tick 续上", async () => {
    const seeded = await seed(["one"]);
    const open = makeHarness(seeded.store);
    await open.session.handshake(handshakeRequest());
    expect(typesOf(await open.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId)))).toEqual(["DOC_BASE"]);

    const blocked = makeHarness(seeded.store);
    await blocked.session.handshake(handshakeRequest());
    fillWindow(blocked.quota);
    const frames = await blocked.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId));
    // 帧数下降而不是报错：窗口已满时订阅成功返回，只是没有可编码帧。
    expect(frames).toHaveLength(0);
    expect(blocked.planCalls()).toBe(0);
    // 额度归还后不需要重新订阅：tick 从同一位置续上，帧数回到正常连接的 1 帧。
    releaseWindow(blocked.quota);
    expect(typesOf(await blocked.session.tick())).toEqual(["DOC_BASE"]);
  });

  // 顺序不可换：DOC_BASE → 客户端 processed 回执 → BASE_READY → S+1 起的连续 DOC_UPDATE。
  test("base 回执后才发 BASE_READY，其后才发 S+1 起的连续 tail", async () => {
    const seeded = await seed(["one", "two"]);
    const harness = makeHarness(seeded.store);
    await harness.session.handshake(handshakeRequest());
    const subscribed = await harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId));
    const base = frameOf(subscribed, "DOC_BASE");
    expect([base.mode, base.baseSeq]).toEqual(["full", 2]);
    expect(base.payloadDigest).toBe(sha256Digest(new Uint8Array(Buffer.from(base.payload, "base64"))));
    // 回执未到：既不补 BASE_READY，也不发 tail。
    expect(await harness.session.tick()).toHaveLength(0);

    subscribed[0].onHandedOff?.();
    const readyFrames = await harness.session.onAck(subscribed[0].deliveryId, "processed");
    expect(typesOf(readyFrames)).toEqual(["BASE_READY"]);
    expect(frameOf(readyFrames, "BASE_READY").baseSeq).toBe(base.baseSeq);

    // 订阅之后发生的新写入：tail 必须从 S+1 起连续。
    await appendText(seeded, "three");
    const tailFrames = await harness.session.tick();
    expect(typesOf(tailFrames)).toEqual(["DOC_UPDATE"]);
    const update = frameOf(tailFrames, "DOC_UPDATE");
    expect([update.fromSeq, update.toSeq]).toEqual([base.baseSeq + 1, base.baseSeq + 1]);
    expect(update.payloadDigest).toBe(sha256Digest(new Uint8Array(Buffer.from(update.payload, "base64"))));
    expect([update.docId, update.generation]).toEqual([seeded.refs.runtimeDocId, GENERATION]);
    // 帧头完整性：同一次订阅内代次、epoch 与 attempt 一致，投递号各不相同。
    expect([update.transportEpoch, update.subscriptionEpoch, update.syncAttemptId]).toEqual([
      base.transportEpoch,
      base.subscriptionEpoch,
      base.syncAttemptId,
    ]);
    expect(new Set([base.deliveryId, update.deliveryId]).size).toBe(2);
    // 载荷真实可用：base + tail 重建出的状态与服务端文档一致。
    const rebuilt = rebuildFrom(base.payload, [update.payload]);
    expect(rebuilt.getText("t").toString()).toBe(seeded.serverDoc.getText("t").toString());

    // 回执结清传输额度：两帧全部结算后窗口回到零。
    tailFrames[0].onHandedOff?.();
    await harness.session.onAck(tailFrames[0].deliveryId, "processed");
    expect(harness.quota.snapshot().outstandingBytes).toBe(0);
    expect(harness.ledger.outstandingCount()).toBe(0);
  });

  // 未交接基线被放弃时必须恢复调度责任，迟到回执不能替未到达的基线确认完成。
  test("abandonDelivery 归还窗口字节但不推进游标，重复调用与未知 id 无副作用", async () => {
    const seeded = await seed(["one", "two"]);
    const harness = makeHarness(seeded.store);
    await harness.session.handshake(handshakeRequest());
    const subscribed = await harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId));
    const base = frameOf(subscribed, "DOC_BASE");
    const reserved = harness.quota.snapshot().outstandingBytes;
    expect(reserved).toBeGreaterThan(0);

    harness.session.abandonDelivery(base.deliveryId);
    expect(harness.quota.snapshot().outstandingBytes).toBe(0);
    expect(harness.ledger.outstandingCount()).toBe(0);
    // 幂等：同一条再丢弃一次不归还第二份（重复归还会凭空造额度）。
    harness.session.abandonDelivery(base.deliveryId);
    harness.session.abandonDelivery("dlv_0011223344556677");
    expect(harness.quota.snapshot().outstandingBytes).toBe(0);

    expect(await harness.session.onAck(base.deliveryId, "processed")).toHaveLength(0);
    const retried = await harness.session.tick();
    expect(typesOf(retried)).toEqual(["DOC_BASE"]);
    expect(retried[0].deliveryId).not.toBe(base.deliveryId);
    retried[0].onHandedOff?.();
    expect(typesOf(await harness.session.onAck(retried[0].deliveryId, "processed"))).toEqual(["BASE_READY"]);
  });

  // rejected 只结清传输额度并进入 resync：不推进 base、不发 BASE_READY、不发 tail。
  test("rejected 回执只结清传输额度并进入 resync，不推进 base 与游标", async () => {
    const seeded = await seed(["one"]);
    const harness = makeHarness(seeded.store);
    await harness.session.handshake(handshakeRequest());
    const subscribed = await harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId));
    const base = frameOf(subscribed, "DOC_BASE");

    subscribed[0].onHandedOff?.();
    expect(await harness.session.onAck(subscribed[0].deliveryId, "rejected")).toHaveLength(0);
    expect(harness.session.state).toBe("resync-required");
    // 传输额度已结清，但业务边界没动：既没有 BASE_READY，也没有尾部更新。
    expect(harness.quota.snapshot().outstandingBytes).toBe(0);
    expect(harness.ledger.outstandingCount()).toBe(0);
    expect(await harness.session.tick()).toHaveLength(0);

    // 补齐走显式 resync：通告旧 attempt 已废止，并换新 attempt 重新协商 base。
    const notice = frameOf(await harness.session.resync(seeded.refs.runtimeDocId), "RESYNC");
    expect([notice.previousSubscriptionEpoch, notice.previousSyncAttemptId]).toEqual([
      base.subscriptionEpoch,
      base.syncAttemptId,
    ]);
    const again = frameOf(await harness.session.tick(), "DOC_BASE");
    expect([again.syncAttemptId, again.mode, again.baseSeq]).toEqual([notice.attemptId, "full", base.baseSeq]);
    expect(again.subscriptionEpoch).not.toBe(base.subscriptionEpoch);
  });

  // 旧 attempt 的迟到回执只结清原账本：不 apply、不改新游标，新 attempt 仍要自己的回执才 READY。
  test("resync 废止旧任务，旧 attempt 的迟到回执不改新游标", async () => {
    const seeded = await seed(["one"]);
    const harness = makeHarness(seeded.store);
    await harness.session.handshake(handshakeRequest());
    const first = await harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId));
    const stale = frameOf(first, "DOC_BASE");
    const staleBytes = encodeSyncFrame(first[0].frame).length;

    const notice = frameOf(await harness.session.resync(seeded.refs.runtimeDocId), "RESYNC");
    const freshFrames = await harness.session.tick();
    freshFrames[0].onHandedOff?.();
    first[0].onHandedOff?.();
    const fresh = frameOf(freshFrames, "DOC_BASE");
    expect(fresh.syncAttemptId).toBe(notice.attemptId);
    expect(fresh.deliveryId).not.toBe(stale.deliveryId);
    const outstanding = harness.quota.snapshot().outstandingBytes;

    // 迟到回执：只归还旧帧占用的额度，新 attempt 的游标与 base 一步不动。
    expect(await harness.session.onAck(first[0].deliveryId, "processed")).toHaveLength(0);
    expect(harness.quota.snapshot().outstandingBytes).toBe(outstanding - staleBytes);
    expect(await harness.session.tick()).toHaveLength(0);
    expect(harness.session.state).toBe("syncing");

    // 新 attempt 自己的回执才是它 READY 的依据。
    expect(typesOf(await harness.session.onAck(fresh.deliveryId, "processed"))).toEqual(["BASE_READY"]);
  });

  // 换代只认存储背书的修订：更高 revision 且为当前代次才成套切换，同 revision 只接受一致重传。
  test("换代只接受更高或同 revision 的一致重传，并成套切换入口", async () => {
    const seeded = await seed(["one"]);
    const harness = makeHarness(seeded.store);
    await harness.session.handshake(handshakeRequest());
    await harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId));
    const nextRefs = await commitNextGeneration(seeded, NEXT_GENERATION);

    // 旧 revision、未提交的更高 revision、以及 revision 到位但代次不是当前代次：全部拒绝。
    const replace = harness.session.replaceGeneration.bind(harness.session);
    expect([
      await codeOf(() => replace({ generation: NEXT_GENERATION, pointerRevision: 1 })),
      await codeOf(() => replace({ generation: NEXT_GENERATION, pointerRevision: 3 })),
      await codeOf(() => replace({ generation: GENERATION, pointerRevision: 2 })),
    ]).toEqual(["POINTER_REVISION_STALE", "GENERATION_MISMATCH", "GENERATION_NOT_CURRENT"]);

    // 更高 revision 且目标为当前代次：成套切换，通告里带齐代次、修订与三个入口。
    const replaced = frameOf(
      await harness.session.replaceGeneration({ generation: NEXT_GENERATION, pointerRevision: 2 }),
      "GENERATION_REPLACE",
    );
    expect(replaced).toEqual({
      type: "GENERATION_REPLACE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      generation: NEXT_GENERATION,
      pointerRevision: 2,
      referenceRevision: 2,
      controlDocId: nextRefs.controlDocId,
      directoryDocId: nextRefs.directoryDocId,
      runtimeDocId: nextRefs.runtimeDocId,
    });
    // 旧代次的订阅随之作废：同一帧不再续发，旧 docId 也被代次一致性挡在门外。
    expect(await harness.session.tick()).toHaveLength(0);
    expect(await codeOf(() => harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId)))).toBe(
      "GENERATION_MISMATCH",
    );
    expect(
      frameOf(await harness.session.subscribe(subscribeRequest(nextRefs.runtimeDocId)), "DOC_BASE").generation,
    ).toBe(NEXT_GENERATION);

    // 同 revision 一致重传幂等；同 revision 异代次是冲突，不能就地切走。
    expect(await replace({ generation: NEXT_GENERATION, pointerRevision: 2 })).toHaveLength(0);
    expect(await codeOf(() => replace({ generation: GENERATION, pointerRevision: 2 }))).toBe("GENERATION_MISMATCH");
  });

  // dirty 集合是「连接跟不上了」的信号：超过 maxDirtyDocs 必须关闭连接并要求重新握手。
  test("dirty 集合超过 maxDirtyDocs 时关闭连接并要求重新握手", async () => {
    const seeded = await seed();
    const harness = makeHarness(seeded.store, { maxDirtyDocs: 2 });
    await harness.session.handshake(handshakeRequest());
    const docIds = [seeded.refs.controlDocId, seeded.refs.runtimeDocId, seeded.refs.directoryDocId];

    expect(await codeOf(() => harness.session.subscribe({ docIds, priority: "live" }))).toBe("CAPACITY_EXCEEDED");
    // 会话自锁：不再产出任何帧，连接所有权交回调用方。
    expect(harness.session.state).toBe("closed");
    expect(await harness.session.tick()).toHaveLength(0);
  });

  // 关闭即终态：不再产出任何帧，额度与账本同时清账。
  test("close 之后不再产出任何帧", async () => {
    const seeded = await seed(["one"]);
    const harness = makeHarness(seeded.store);
    await harness.session.handshake(handshakeRequest());
    const subscribed = await harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId));
    expect(harness.ledger.outstandingCount()).toBe(1);

    harness.session.close();
    expect(harness.session.state).toBe("closed");
    expect(await harness.session.tick()).toHaveLength(0);
    expect(await harness.session.onAck(subscribed[0].deliveryId, "processed")).toHaveLength(0);
    expect(await harness.session.resync(seeded.refs.runtimeDocId)).toHaveLength(0);
    expect(await harness.session.replaceGeneration({ generation: GENERATION, pointerRevision: 1 })).toHaveLength(0);
    expect(await harness.session.subscribe(subscribeRequest(seeded.refs.runtimeDocId))).toHaveLength(0);
    expect(await harness.session.handshake(handshakeRequest())).toHaveLength(0);
    // 关即清账：在途投递与占用额度一并归零。
    expect([harness.quota.snapshot().outstandingBytes, harness.ledger.outstandingCount()]).toEqual([0, 0]);
  });
});
