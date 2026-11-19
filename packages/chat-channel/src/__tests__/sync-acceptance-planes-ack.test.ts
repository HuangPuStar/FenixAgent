// 同步端到端行为验收。
import { describe, expect, test } from "bun:test";

import { type ApplyAckFrame, SYNC_PROTOCOL_VERSION } from "../sync/protocol/frames";
import { mirrorText, primaryOf, TIGHT_WINDOW_BYTES, withHarness, writeChunks } from "./sync-acceptance-planes-fixture";
import { duplicateRecordIds, type PlaneConnection } from "./sync-acceptance-planes-oracle";

function ackFrames(connection: PlaneConnection): ApplyAckFrame[] {
  return connection.link.observedInbound.filter((frame): frame is ApplyAckFrame => frame.type === "APPLY_ACK");
}

/** 取最近一条已投递数据帧的身份：伪造回执必须复用真实 deliveryId 才叫「旧代次回执」。 */
function lastDeliveredFrame(connection: PlaneConnection): {
  deliveryId: string;
  transportEpoch: string;
  docId: string;
} {
  for (let index = connection.link.accepted.length - 1; index >= 0; index -= 1) {
    const frame = connection.link.accepted[index].frame;
    if (frame.type === "DOC_BASE" || frame.type === "DOC_UPDATE") {
      return { deliveryId: frame.deliveryId, transportEpoch: frame.transportEpoch, docId: frame.docId };
    }
  }
  throw new Error("acceptance: connection has no delivered data frame");
}

describe("T10 回执丢失、重复与旧代次，丢 update 后重连", () => {
  // 回执丢失：到期终止该连接，之后不再堆积新投递（在途不无限增长）。
  test("回执丢失：到期终止该连接，之后不再堆积新投递（在途不无限增长）", async () => {
    const ackMs = 5_000;
    await withHarness({ ackMs }, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      // 只丢回执：数据帧照常到达，服务端却永远收不到结清。
      primary.link.dropInbound = (frame) => frame.type === "APPLY_ACK";
      await harness.writeText("lost-ack");
      expect(mirrorText(primary, harness)).toBe("lost-ack");
      expect(primary.gateway.outstandingDeliveries()).toBeGreaterThan(0);
      expect(primary.audit.outstandingBytes()).toBeGreaterThan(0);

      // 未到期限不掉线：期限判的是「无进展满 ackDeadlineMs」，不是「存在未回执投递」。
      harness.time.advance(ackMs - 1);
      await harness.pump();
      expect(primary.link.closeReasons).toEqual([]);
      expect(primary.gateway.outstandingDeliveries()).toBeGreaterThan(0);

      harness.time.advance(1);
      await harness.pump();
      expect(primary.link.closeReasons.length).toBe(1);
      // 连接终止即清账：账目与额度都不留在死连接上。
      expect(primary.gateway.outstandingDeliveries()).toBe(0);

      // 终态之后不再产生新投递：数据帧总量与客户端内容都停住，在途因此不会继续增长。
      const deliveredCount = primary.link.accepted.length;
      await harness.writeText("after-close");
      await harness.pump();
      expect(primary.link.accepted.length).toBe(deliveredCount);
      expect(mirrorText(primary, harness)).toBe("lost-ack");
      expect(primary.client.hub.queueDepth()).toBe(0);
    });
  });

  // 重复回执只结清一次：账目归零、无重复投递，窗口在后续写入中仍为硬约束。
  test("重复回执只结清一次：账目归零、无重复投递，窗口在后续写入中仍为硬约束", async () => {
    await withHarness({ windowBytes: TIGHT_WINDOW_BYTES }, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      // 每条回执都投递两次（同一帧走两次真实派发路径）；订阅期的回执发生在挂钩子之前，单独排除。
      const acksBefore = ackFrames(primary).length;
      primary.link.duplicateInbound = (frame) => frame.type === "APPLY_ACK";

      const first = await writeChunks(harness, 12);
      expect(mirrorText(primary, harness)).toBe(first);
      const window = ackFrames(primary).slice(acksBefore);
      const distinct = new Set(window.map((frame) => frame.deliveryId)).size;
      // 线上确实发生了重复回执，否则本用例什么都没验证。
      expect(distinct).toBeGreaterThan(0);
      expect(window.length).toBe(distinct * 2);
      expect(primary.gateway.outstandingDeliveries()).toBe(0);
      expect(primary.audit.outstandingBytes()).toBe(0);
      expect(primary.audit.duplicateDeliveries).toEqual([]);
      expect(primary.client.hub.queueDepth()).toBe(0);

      // 额度账目没有被重复归还改写：再写一轮同样大小的内容，仍然只按窗口推进。
      const second = await writeChunks(harness, 12);
      expect(mirrorText(primary, harness)).toBe(first + second);
      expect(primary.audit.outstandingBytes()).toBe(0);
      expect(primary.audit.duplicateDeliveries).toEqual([]);
      expect(primary.audit.unknownAcks).toEqual([]);
      expect(primary.fatal).toEqual([]);
    });
  });

  // 旧代次回执被丢弃：不结清在途，投递仍按期超时并终止连接。
  test("旧代次回执被丢弃：不结清在途，投递仍按期超时并终止连接", async () => {
    const ackMs = 5_000;
    await withHarness({ ackMs }, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      // 真实回执一律丢弃：能结清在途的就只剩那条伪造的旧代次回执。
      primary.link.dropInbound = (frame) => frame.type === "APPLY_ACK";
      const expected = await writeChunks(harness, 3);
      expect(mirrorText(primary, harness)).toBe(expected);

      const delivered = lastDeliveredFrame(primary);
      const forged: ApplyAckFrame = {
        type: "APPLY_ACK",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        transportEpoch: `${delivered.transportEpoch}-stale`,
        deliveryId: delivered.deliveryId,
        result: "processed",
        docId: delivered.docId,
        appliedSeq: 1,
      };
      // 真实回执继续丢，只放行这条伪造帧：它必须走到网关的派发逻辑里被按旧代次丢弃。
      primary.link.dropInbound = (frame) =>
        frame.type === "APPLY_ACK" && frame.transportEpoch !== forged.transportEpoch;
      harness.queueClientFrame(primary, forged);

      harness.time.advance(ackMs - 1);
      await harness.pump();
      // 异代次回执在网关派发前就被丢弃：它的 deliveryId 仍挂在账上，期限一到照常断开。
      expect(primary.audit.staleEpochAcks).toEqual([delivered.deliveryId]);
      expect(primary.gateway.outstandingDeliveries()).toBeGreaterThan(0);
      expect(primary.link.closeReasons).toEqual([]);

      harness.time.advance(1);
      await harness.pump();
      expect(primary.link.closeReasons.length).toBe(1);
      // 账目在终态前一直挂着那条投递，直到连接终止才成对清账。
      expect(primary.gateway.outstandingDeliveries()).toBe(0);
    });
  });

  // 丢 update 后重连：客户端检出缺口并 RESYNC，补齐后序号连续且申请次数有界。
  test("丢 update 后重连：客户端检出缺口并 RESYNC，补齐后序号连续且申请次数有界", async () => {
    await withHarness({ windowBytes: TIGHT_WINDOW_BYTES }, async (harness) => {
      const primary = primaryOf(harness);
      await primary.handshake();
      await primary.subscribe();
      const docId = harness.seedContentDocId;
      // 只丢一条增量帧：客户端会在紧随其后的增量上看到序号缺口。
      let dropped = 0;
      primary.link.dropOutbound = (frame) => {
        if (frame.type !== "DOC_UPDATE" || dropped > 0) return false;
        dropped += 1;
        return true;
      };

      const parts: string[] = [];
      for (let index = 0; index < 8; index += 1) {
        const delta = `${index}:${"x".repeat(1024)}`;
        parts.push(delta);
        await harness.writeText(delta);
      }
      const expected = parts.join("");
      await harness.pump();
      expect(dropped).toBe(1);

      // 缺口由客户端发现并主动申请补齐（服务端不猜），申请次数有界（不做无边界重试）。
      const resyncs = primary.link.observedInbound.filter((frame) => frame.type === "RESYNC");
      expect(resyncs.length).toBeGreaterThanOrEqual(1);
      expect(resyncs.length).toBeLessThanOrEqual(2);
      // 补齐后内容与写入侧一致，且镜像里没有重复记录。
      expect(mirrorText(primary, docId)).toBe(expected);
      expect(duplicateRecordIds(primary.mirror.records(docId))).toEqual([]);
      expect(primary.applied.coverage(docId).gaps).toEqual([]);
      expect(primary.applied.duplicateUpdateSeqs(docId)).toEqual([]);
      expect(primary.fatal).toEqual([]);
      // 被丢弃的投递仍挂在账上（永远等不到回执），但它在途字节不超过一个窗口。
      expect(primary.audit.outstandingBytes()).toBeLessThanOrEqual(TIGHT_WINDOW_BYTES);
    });
  });
});

// ------------------------------------------------------------------ T11 写者竞争 / 租约过期 / 通知丢失

/** 夹具自己在存储边界上登记一条 staging 代次（不经导入服务：T11 只关心写权与修订号的裁决）。 */
