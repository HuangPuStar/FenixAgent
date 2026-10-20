// packages/chat-channel/src/__tests__/sync-acceptance-recovery.test.ts
// B 交付：设计 §15.2 场景矩阵 T13–T24 的**故障与边界**验收。期望值与夹具在同目录的
// `sync-acceptance-recovery-oracle.ts` 内独立生成（设计 §15.1：oracle 不得复用被测实现的分片/拼接/投影）。
//
// 端到端口径：真实 `createSyncScopeRuntime` + 真实 `createSyncClientTransport` + 进程内传输端口 + 真实帧字节
// （线上 JSON 形态，由 oracle 自行解析）；时间一律来自注入的假时钟 `RecoveryClock`，真实定时器只用于 merge
// 缓冲的兜底回调。每个用例自带夹具，`afterEach` 统一释放。
//
// ── T13–T24 判定表（ID / 结论 / 依赖） ─────────────────────────────────────────────────────────────
// 结论口径：已覆盖＝设计 §15.2 的「必须观察」在本文件的用例内有对应断言；部分覆盖＝列出已覆盖项与缺口；
// 不可做＝环境或持久化依赖缺失，本文件**不用进程内近似冒充**。
// | ID  | 结论            | 依赖 / 说明（用例名省略 `Txx-` 前缀） |
// | T13 | 不可做          | 需 24 小时墙钟长跑与 §15.3「标准 profile」固定硬件（CPU 型号/内存/链路都要固定并记录）；内存与吞吐趋势在进程内不可判定，假时钟只能覆盖轮换与热工作集的**正确性**分支。依赖：真实 soak 环境 + 性能口径裁决。 |
// | T14 | 已覆盖          | `异代次 docId 的订阅按 GENERATION_MISMATCH 拒绝`、`同代次未登记 docId 的订阅按 DOC_NOT_FOUND 拒绝`、`跨 scope 隔离`、`ACK 超期关闭连接`（撤权/失能后立即停止后续数据）。 |
// | T15 | 已覆盖          | `超限入站字节`、`版本不匹配：回 ERROR 并关闭`、`非 JSON 与非法结构`、`载荷长度不符`、`apply 失败：rejected + RESYNC`。 |
// | T16 | 不可做          | 需旧二进制 + 旧投影 + 持久化 `protocolVersion` 灰度；单版本进程内无法构造「新旧协议并存」。同代次内的换代由 T20 覆盖，但换代 ≠ 协议版本回退，二者不等价。依赖：可灰度的宿主装配层与旧版客户端。 |
// | T17 | 部分覆盖        | 已覆盖：`重复 DOC_BASE 幂等`、`RESYNC 换新 attempt 后旧帧只结账`、`BASE_READY 只由回执驱动`、`Doc 释放后到达的帧只结账`。未覆盖：同 WS 退订/重订的订阅语义与「纯删除 / pending」判定属 `state/**` 投影层，本阶段未接。 |
// | T18 | 部分覆盖        | 已覆盖：`T18-1a final 描述符落进内容块`、`T18-1b final 把实体移出运行态（纯删除当次落库）`、`T18-1c 封口即落库（静默期不残留）`、`T18-2 冷重连重建`、`T18-3 无内容块代次按 DOC_NOT_FOUND 失败`。未覆盖：运行态轮换（`rotateRuntime`）的实体交接与存储级 GC 时序，依赖真实持久化。 |
// | T19 | 部分覆盖        | 已覆盖：`多内容 Doc 并发驻留`、`接收队列溢出`、`Doc 间不串扰`（写入口＝入口闭包末位内容块）、`release 后拒绝入队`。未覆盖：单 entry 跨 10,000 块、128 驻留 Doc 规模与随机定位/取消，属存储与导出层。 |
// | T20 | 部分覆盖        | 已覆盖：`未提交代次不可握手`、`GENERATION_REPLACE 三种 revision 语义`、`换代后旧代次被隔离`。未覆盖：ACP 绑定冻结（需宿主接线，本阶段不做）。 |
// | T21 | 不可做（持久化分支） | 「SQL 提交成功但响应丢失、进程重启后 pointerRevision 不回退、原字节幂等」需真实 SQL adapter 与进程重启。进程内**等价物**见 `T21-1 等价物`：旧 epoch 写操作被 fencing、陈旧修订换代返回 conflict 且指针不变——用例名已标注「等价物」，不冒充持久化分支。 |
// | T22 | 部分覆盖        | 已覆盖：`socket 饱和拒发后由搁置重试补齐`、`控制帧率不足时回帧被搁置`、`订阅超出 dirty 上限`、接收队列溢出（见 T19-2）。未覆盖：全池饱和与 §15.3 压测口径（依赖固定硬件与标准 profile）。 |
// | T23 | 不可做          | 需 sharedrelay 真实进程与真实磁盘满故障注入；本阶段没有 spool 故障注入面（`history/spool.ts` 无失败注入点），进程内近似会冒充已覆盖。依赖：sharedrelay 运行环境 + 故障注入工具。 |
// | T24 | 部分覆盖        | 已覆盖：`活动租约下写入按 SCOPE_BUSY 失败`、`dispose 幂等且入口封闭`、`断连不丢已提交内容`、`二次 attachTransport 被拒`。未覆盖：真实删除 GC 与 React Strict Mode 双挂载竞态（属宿主前端）。 |
//
// 跨 ID 的未覆盖项：T07 与 T21 的**持久化分支**（真实 SQL 幂等、封口提交点杀进程/崩溃后重启恢复）不在本文件
// 覆盖范围内——两者都依赖真实 PostgreSQL adapter 与进程重启，无法用进程内 store 近似；本文件不做该替代。
//
// ── 曾经的失败项（wave4 已修，断言改写为契约形态） ───────────────────────────────────────────────────
// 缺陷 1（原 `T18-1b` / `T18-1c`）：`final` 的纯删除被 `capture` 的 state-vector 比对静默丢弃，运行态实体永不落库。
//   修复：`sync/live/change-capture.ts` 改读 Yjs update 事件（纯删除同样触发）；两用例改为断言「封口当次落库」。
// 缺陷 3（原 `T22-1`）：socket 饱和拒发的数据帧被永久跳过，缺口出网、客户端只能靠 RESYNC 换基线补齐。
//   修复：网关搁置位 + `driveWithheld()` 每 tick 重试（`sync/runtime/egress.ts:279-292`）；缺口在服务端愈合，
//   本用例因此断言 `RESYNC = 0` 与内容收敛（RESYNC 机制本身由 T15-5 / T17-2 独立覆盖）。

import { afterEach, describe, expect, test } from "bun:test";
import { CLIENT_BUDGET } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import { MAX_DATA_FRAME_BYTES, SYNC_PROTOCOL_VERSION, type SyncFrame } from "../sync/protocol/frames";
import { buildDocId, type SyncScope, scopeKey } from "../sync/protocol/identity";
import { resolveSyncRuntimeConfig } from "../sync/runtime/config";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import {
  bytesEqual,
  concatEntryTexts,
  createRecoveryHarness,
  extractEntities,
  extractRecords,
  frameFieldsOf,
  frameTypeOf,
  RecoveryClock,
  type RecoveryHarness,
  seedCommittedGeneration,
  seededDocIdsFor,
  type WireRecord,
} from "./sync-acceptance-recovery-oracle";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const LIFECYCLE = { sealGraceMs: 1000, retireGraceMs: 1000 } as const;

const harnesses: RecoveryHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

async function harness(options?: Parameters<typeof createRecoveryHarness>[0]): Promise<RecoveryHarness> {
  const created = await createRecoveryHarness(options);
  harnesses.push(created);
  return created;
}

/** 从任意异常里取协议码：oracle 侧不 import 生产错误类，只读 `.code` 这个线上契约字段。 */
function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return `<no protocol code: ${String(error)}>`;
}

/** 断言动作必须失败，并返回其协议码（成功即判失败，避免用例静默通过）。 */
async function rejectionCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return codeOf(error);
  }
  throw new Error("expected the action to reject with a SyncProtocolError");
}

interface FrameView {
  readonly type: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

function framesOf(wire: readonly Uint8Array[]): FrameView[] {
  const out: FrameView[] = [];
  for (const bytes of wire) {
    const fields = frameFieldsOf(bytes);
    const type = fields?.type;
    if (fields === null || typeof type !== "string") continue;
    out.push({ type, fields });
  }
  return out;
}

function frameTypes(wire: readonly Uint8Array[]): string[] {
  return framesOf(wire).map((frame) => frame.type);
}

function stringField(frame: FrameView, key: string): string | undefined {
  const value = frame.fields[key];
  return typeof value === "string" ? value : undefined;
}

function framesWithType(wire: readonly Uint8Array[], type: string): FrameView[] {
  return framesOf(wire).filter((frame) => frame.type === type);
}

function onlyFrame(wire: readonly Uint8Array[], type: string): FrameView {
  const matches = framesWithType(wire, type);
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${type} frame, got ${matches.length}`);
  }
  const frame = matches[0];
  if (frame === undefined) throw new Error(`missing ${type} frame`);
  return frame;
}

/** 取某 Doc 最近一条数据帧的线上身份（构造「同 attempt 的迟到帧」时用它，避免自造 identity）。 */
function lastIdentity(
  wire: readonly Uint8Array[],
  docId: string,
  type = "DOC_BASE",
): { readonly subscriptionEpoch: string; readonly syncAttemptId: string; readonly transportEpoch: string } {
  const matches = framesWithType(wire, type).filter((frame) => stringField(frame, "docId") === docId);
  const frame = matches.at(-1);
  if (frame === undefined) throw new Error(`no ${type} frame for ${docId}`);
  const subscriptionEpoch = stringField(frame, "subscriptionEpoch");
  const syncAttemptId = stringField(frame, "syncAttemptId");
  const transportEpoch = stringField(frame, "transportEpoch");
  if (subscriptionEpoch === undefined || syncAttemptId === undefined || transportEpoch === undefined) {
    throw new Error(`${type} frame for ${docId} carries no complete identity`);
  }
  return { subscriptionEpoch, syncAttemptId, transportEpoch };
}

/** 手工构造线上帧字节（不经生产编码器，保持 oracle 侧独立）。 */
function wireBytes(frame: Readonly<Record<string, unknown>>): Uint8Array {
  return TEXT_ENCODER.encode(JSON.stringify(frame));
}

/** 客户端 outbox 里针对某投递的回执结果（未 flush 也能观察）。 */
function ackResults(outbox: readonly Uint8Array[], deliveryId: string): string[] {
  return framesOf(outbox)
    .filter((frame) => frame.type === "APPLY_ACK" && stringField(frame, "deliveryId") === deliveryId)
    .map((frame) => stringField(frame, "result") ?? "<missing>");
}

function helloFrame(scope: SyncScope, generation: string, loadedDocs: readonly string[] = []): SyncFrame {
  return {
    type: "HELLO",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    scope: { organizationId: scope.organizationId, rcsSessionId: scope.rcsSessionId },
    generation,
    loadedDocs: loadedDocs.map((docId) => ({ docId })),
    stateful: false,
  };
}

function subscribeFrame(docIds: readonly string[], priority: "live" | "currentHistory" = "live"): SyncFrame {
  return { type: "SUBSCRIBE", protocolVersion: SYNC_PROTOCOL_VERSION, docIds: [...docIds], priority };
}

/** 标准连接：retain → HELLO → SUBSCRIBE → 往返收敛（默认订阅正文 Doc）。 */
async function connected(
  options?: Parameters<typeof createRecoveryHarness>[0],
  docIds?: readonly string[],
): Promise<RecoveryHarness> {
  const created = await harness(options);
  const docs = docIds ?? [created.docIds.content];
  for (const docId of docs) created.client.hub.retain(docId);
  await created.sendClientFrame(helloFrame(created.scope, created.generation));
  await created.sendClientFrame(subscribeFrame(docs));
  await created.settle();
  return created;
}

/** 写入一条文本记录并立刻用语义屏障冲刷（屏障保证文本先落库，写入后无需等待真实定时器）。 */
async function writeTextEntry(created: RecoveryHarness, entryId: string, text: string): Promise<void> {
  await created.runtime.acceptIngress({
    kind: "text-delta",
    turnId: entryId,
    entryId,
    contentSlot: "0",
    contentType: "text",
    delta: text,
  });
  await created.runtime.acceptIngress({
    kind: "semantic",
    turnId: entryId,
    entryId,
    contentSlot: "0",
    contentType: "text",
    semantic: { kind: "tool", payload: { entityId: `${entryId}:tool`, toolCallId: `tc_${entryId}` } },
  });
}

/** 重建某 Doc 并把记录按 `entryId/partIndex` 拼成文本表（键用 `/` 连接，便于整体相等断言）。 */
function textsOf(created: RecoveryHarness, docId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, text] of concatEntryTexts(extractRecords(created.reconstruct(docId)))) {
    out[key.replace("\u0000", "/")] = text;
  }
  return out;
}

function recordsOfKind(records: readonly WireRecord[], kind: string): WireRecord[] {
  return records.filter((record) => record.kind === kind);
}

describe("T14 归属与隔离", () => {
  // 异代次 docId 命中代次归属边界：服务端必须按 GENERATION_MISMATCH 拒绝，且不产出任何帧。
  test("T14-1 异代次 docId 的订阅按 GENERATION_MISMATCH 拒绝", async () => {
    const created = await connected();
    const foreign = seededDocIdsFor("gen_foreign_scope").content;
    const wireBefore = created.wireToClient.length;
    const code = await rejectionCode(() => created.sendClientFrame(subscribeFrame([foreign])));
    expect(code).toBe("GENERATION_MISMATCH");
    expect(created.wireToClient.length).toBe(wireBefore);
  });

  // 同代次但没有已提交状态的 docId：归属通过、状态缺失，必须按 DOC_NOT_FOUND 拒绝而不是静默等待。
  test("T14-2 同代次未登记 docId 的订阅按 DOC_NOT_FOUND 拒绝", async () => {
    const created = await connected();
    const unknown = buildDocId({ kind: "content", generation: created.generation, blockIndex: 7, nonce: "absent" });
    const code = await rejectionCode(() => created.sendClientFrame(subscribeFrame([unknown])));
    expect(code).toBe("DOC_NOT_FOUND");
  });

  // 指针是唯一权威：别的 scope 的代次在本 scope 不可握手，隔离不会让任一 scope 的状态被另一 scope 改变。
  test("T14-3 跨 scope 隔离：异 scope 代次不可握手，本 scope 不受影响", async () => {
    const first = await harness();
    const second = await harness({
      scope: { organizationId: "org_acceptance_other", rcsSessionId: "rcs_acceptance_recovery_other" },
    });
    const code = await rejectionCode(() => second.sendClientFrame(helloFrame(second.scope, first.generation)));
    expect(code).toBe("GENERATION_NOT_CURRENT");
    expect(frameTypes(second.wireToClient)).not.toContain("MANIFEST");

    first.client.hub.retain(first.docIds.content);
    await first.sendClientFrame(helloFrame(first.scope, first.generation));
    await first.sendClientFrame(subscribeFrame([first.docIds.content]));
    await first.settle();
    expect(frameTypes(first.wireToClient)).toContain("BASE_READY");
    expect(first.fatalCodes).toEqual([]);
  });

  // 连接终止：ACK 超期即关连接并清空在途登记；终止后不再产出任何帧（不能靠停发判定为「已送达」）。
  test("T14-4 ACK 超期关闭连接：在途登记清零且不再产出帧", async () => {
    const created = await connected();
    await writeTextEntry(created, "entry-timeout", "ack-timeout");
    await created.runtime.tick();
    const outstanding = created.outstandingDeliveries();
    expect(outstanding).toBeGreaterThan(0);

    created.clock.advance(created.config.deadlines.ackMs + 1);
    await created.runtime.tick();
    expect(created.serverCloseReasons).toEqual([`ack timeout for ${outstanding} outstanding deliveries`]);
    expect(created.outstandingDeliveries()).toBe(0);
    expect(created.outboundClosed).toBe(true);

    const wireBefore = created.wireToClient.length;
    created.clock.advance(60_000);
    await created.runtime.tick();
    expect(created.wireToClient.length).toBe(wireBefore);
  });
});

describe("T15 帧层与载荷边界", () => {
  // 尺寸预检在解析之前：超过数据帧上限的输入不需要内容即可判定，也不把解析开销转嫁给服务端。
  test("T15-1 超限入站字节按 FRAME_TOO_LARGE 拒绝", async () => {
    const created = await harness();
    const oversize = new Uint8Array(MAX_DATA_FRAME_BYTES + 1);
    expect(await rejectionCode(() => created.runtime.onInboundBytes(oversize))).toBe("FRAME_TOO_LARGE");
  });

  // 版本协商是终结路径：回 ERROR 帧（本端版本）并关闭连接，绝不静默降级成「能解析多少算多少」。
  test("T15-2 版本不匹配：回 ERROR 帧并关闭连接", async () => {
    const created = await harness();
    const raw = wireBytes({
      type: "HELLO",
      protocolVersion: SYNC_PROTOCOL_VERSION + 1,
      scope: { organizationId: created.scope.organizationId, rcsSessionId: created.scope.rcsSessionId },
      generation: created.generation,
      loadedDocs: [],
      stateful: false,
    });
    await created.runtime.onInboundBytes(raw);

    const error = onlyFrame(created.wireToClient, "ERROR");
    expect(stringField(error, "code")).toBe("PROTOCOL_VERSION_UNSUPPORTED");
    expect(error.fields.protocolVersion).toBe(SYNC_PROTOCOL_VERSION);
    expect(created.fatalCodes.map((fatal) => fatal.code)).toContain("PROTOCOL_VERSION_UNSUPPORTED");
    expect(created.outboundClosed).toBe(true);
    expect(created.serverCloseReasons).toEqual([`unsupported protocol version ${SYNC_PROTOCOL_VERSION + 1}`]);

    // 关闭之后连合法的握手也不再有回音：连接已终结，不是「半握手」。
    const wireBefore = created.wireToClient.length;
    await created.sendClientFrame(helloFrame(created.scope, created.generation));
    await created.runtime.tick();
    expect(created.wireToClient.length).toBe(wireBefore);
  });

  // 坏输入不吞错：非 JSON 与结构不合法的 JSON 都必须抛出 MALFORMED_FRAME，由调用方决定是否关连接。
  test("T15-3 非 JSON 与非法结构按 MALFORMED_FRAME 抛出", async () => {
    const created = await harness();
    expect(await rejectionCode(() => created.runtime.onInboundBytes(TEXT_ENCODER.encode("{ not json")))).toBe(
      "MALFORMED_FRAME",
    );
    const wrongShape = wireBytes({ type: "HELLO", protocolVersion: SYNC_PROTOCOL_VERSION });
    expect(await rejectionCode(() => created.runtime.onInboundBytes(wrongShape))).toBe("MALFORMED_FRAME");
  });

  // 载荷长度不符：解码与长度校验都在 onmessage 边界内转成 onFatal，不得抛回调用方栈（浏览器事件循环）。
  test("T15-4 载荷长度不符：onFatal(MALFORMED_FRAME) 且不抛回调用栈", async () => {
    const created = await connected();
    const docId = created.docIds.content;
    const identity = lastIdentity(created.wireToClient, docId);
    const bytes = wireBytes({
      type: "DOC_UPDATE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docId,
      generation: created.generation,
      transportEpoch: identity.transportEpoch,
      subscriptionEpoch: identity.subscriptionEpoch,
      syncAttemptId: identity.syncAttemptId,
      deliveryId: "dl_len_mismatch",
      fromSeq: 1,
      toSeq: 1,
      payloadDigest: "dg_len_mismatch",
      encodedLength: 99,
      payload: "AAAA",
    });
    created.client.onFrame(bytes);
    expect(created.fatalCodes.map((fatal) => fatal.code)).toContain("MALFORMED_FRAME");
    expect(ackResults(created.clientOutbox, "dl_len_mismatch")).toEqual([]);
  });

  // 载荷能解码但不是合法的 Yjs 更新：apply 失败必须走 rejected + RESYNC，而不是当成协议级失败上报。
  test("T15-5 apply 失败：rejected 回执 + RESYNC，不误报 fatal", async () => {
    const created = await connected();
    const docId = created.docIds.content;
    const identity = lastIdentity(created.wireToClient, docId);
    const bytes = wireBytes({
      type: "DOC_BASE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docId,
      generation: created.generation,
      transportEpoch: identity.transportEpoch,
      subscriptionEpoch: identity.subscriptionEpoch,
      syncAttemptId: identity.syncAttemptId,
      deliveryId: "dl_broken_update",
      baseSeq: 1,
      mode: "full",
      payloadDigest: "dg_broken_update",
      // `////` = 3 个 0xFF 字节：长度校验通过（3 = 3），但 Yjs 解不出结构 → apply 失败。
      encodedLength: 3,
      payload: "////",
    });
    created.client.onFrame(bytes);
    await created.client.drain();

    expect(ackResults(created.clientOutbox, "dl_broken_update")).toEqual(["rejected"]);
    const resync = framesWithType(created.clientOutbox, "RESYNC");
    expect(resync.length).toBeGreaterThan(0);
    expect(resync.every((frame) => stringField(frame, "docId") === docId)).toBe(true);
    expect(created.fatalCodes).toEqual([]);
  });
});

describe("T17 回执与 attempt 交错", () => {
  // 同一 deliveryId 的 base 重放：Yjs 语义幂等，内容不变、游标不回退，回执仍按该投递结清一次。
  test("T17-1 重复 DOC_BASE 幂等：内容与游标不变，回执照发", async () => {
    const created = await connected();
    const docId = created.docIds.content;
    await writeTextEntry(created, "entry-dup", "dup-text");
    await created.settle();
    const before = textsOf(created, docId);
    const baseCount = framesWithType(created.wireToClient, "DOC_BASE").length;
    expect(baseCount).toBeGreaterThan(0);
    const firstBase = created.wireToClient.find(
      (bytes) => frameTypeOf(bytes) === "DOC_BASE" && frameFieldsOf(bytes)?.docId === docId,
    );
    expect(firstBase).toBeDefined();
    if (firstBase === undefined) throw new Error("missing DOC_BASE bytes");
    const deliveryId = String(frameFieldsOf(firstBase)?.deliveryId ?? "");
    expect(deliveryId.length).toBeGreaterThan(0);

    created.client.onFrame(firstBase);
    await created.client.drain();

    expect(ackResults(created.clientOutbox, deliveryId)).toEqual(["processed"]);
    expect(textsOf(created, docId)).toEqual(before);
    expect(created.fatalCodes).toEqual([]);
  });

  // RESYNC 换 attempt：新 attempt 的 base 重新协商基线，旧 attempt 的帧只结清原账本、不再申请补齐。
  test("T17-2 RESYNC 换新 attempt：旧帧只结账不推进新游标", async () => {
    const created = await connected();
    const docId = created.docIds.content;
    await writeTextEntry(created, "entry-resync", "resync-text");
    await created.settle();
    const oldBase = created.wireToClient.find(
      (bytes) => frameTypeOf(bytes) === "DOC_BASE" && frameFieldsOf(bytes)?.docId === docId,
    );
    if (oldBase === undefined) throw new Error("missing DOC_BASE bytes");
    const oldAttempt = lastIdentity(created.wireToClient, docId).syncAttemptId;

    created.client.requestResync(docId);
    await created.settle();
    const newAttempt = lastIdentity(created.wireToClient, docId).syncAttemptId;
    expect(newAttempt).not.toBe(oldAttempt);
    expect(frameTypes(created.wireToClient)).toContain("RESYNC");
    expect(textsOf(created, docId)).toEqual({ "entry-resync/0": "resync-text" });

    const resyncBefore = framesWithType(created.wireToServer, "RESYNC").length;
    const ackBefore = framesWithType(created.wireToServer, "APPLY_ACK").length;
    // 旧 attempt 的基线帧重新到达：身份已被替换，只结清账本、不产生第二次补齐申请。
    created.client.onFrame(oldBase);
    await created.client.drain();
    expect(frameTypes(created.clientOutbox)).toContain("APPLY_ACK");
    expect(framesWithType(created.clientOutbox, "RESYNC")).toEqual([]);
    await created.flushClientFrames();
    expect(framesWithType(created.wireToServer, "RESYNC").length).toBe(resyncBefore);
    expect(framesWithType(created.wireToServer, "APPLY_ACK").length).toBe(ackBefore + 1);
    expect(textsOf(created, docId)).toEqual({ "entry-resync/0": "resync-text" });
  });

  // 顺序不可换：基线可信只由 processed 回执证明，未收到回执前服务端不得补发 BASE_READY。
  test("T17-3 BASE_READY 只由回执驱动：ACK 前不发", async () => {
    const created = await harness();
    const docId = created.docIds.content;
    created.client.hub.retain(docId);
    await created.sendClientFrame(helloFrame(created.scope, created.generation));
    await created.sendClientFrame(subscribeFrame([docId]));
    await created.runtime.tick();

    expect(frameTypes(created.wireToClient)).toContain("DOC_BASE");
    expect(frameTypes(created.wireToClient)).not.toContain("BASE_READY");
    expect(created.client.hub.queueDepth()).toBeGreaterThan(0);

    await created.settle();
    expect(frameTypes(created.wireToClient)).toContain("BASE_READY");
    expect(textsOf(created, docId)).toEqual({});
  });

  // Doc 已 release：帧没有归属，只结清传输额度，不得据它重新订阅（否则会产生退订风暴）。
  test("T17-4 Doc 释放后到达的帧只结账：unknown-doc，不申请补齐", async () => {
    const created = await connected();
    const docId = created.docIds.content;
    created.client.hub.release(docId);
    const ackBefore = framesWithType(created.wireToServer, "APPLY_ACK").length;
    const resyncBefore = framesWithType(created.wireToServer, "RESYNC").length;

    await writeTextEntry(created, "entry-released", "released-text");
    await created.settle();

    const acks = framesWithType(created.wireToServer, "APPLY_ACK");
    expect(acks.length).toBeGreaterThan(ackBefore);
    expect(acks.slice(ackBefore).every((frame) => stringField(frame, "result") === "rejected")).toBe(true);
    expect(framesWithType(created.wireToServer, "RESYNC").length).toBe(resyncBefore);
    expect(created.fatalCodes).toEqual([]);
  });
});

describe("T18 终态描述符与冷重连", () => {
  // final 描述符交接的第一半：描述符落进内容块（客户端据此定位终态内容）；封口前该实体仍在运行态里。
  test("T18-1a final 描述符落进内容块", async () => {
    const created = await harness();
    const contentDoc = created.docIds.content;
    const runtimeDoc = created.docIds.runtime;
    created.client.hub.retain(contentDoc);
    created.client.hub.retain(runtimeDoc);
    await created.sendClientFrame(helloFrame(created.scope, created.generation));
    await created.sendClientFrame(subscribeFrame([contentDoc, runtimeDoc]));
    await created.settle();

    await created.runtime.acceptIngress({
      kind: "semantic",
      turnId: "turn-final",
      entryId: "entry-final",
      contentSlot: "0",
      contentType: "tool",
      semantic: { kind: "tool", payload: { entityId: "entity_final", toolCallId: "tc_final" } },
    });
    await created.settle();
    expect(extractEntities(created.reconstruct(runtimeDoc)).map((entity) => entity.entityId)).toContain("entity_final");

    const descriptor = {
      kind: "tool",
      contentRef: "blk_acceptance",
      digest: "dg_acceptance_final",
      byteLength: 42,
      completedAt: 1_700_000_000_000,
    };
    await created.runtime.acceptIngress({
      kind: "semantic",
      turnId: "turn-final",
      entryId: "entry-final",
      contentSlot: "0",
      contentType: "tool",
      semantic: { kind: "final", payload: { entityId: "entity_final", finalDescriptor: descriptor } },
    });
    await created.settle();

    const finals = recordsOfKind(extractRecords(created.reconstruct(contentDoc)), "final");
    expect(finals.length).toBe(1);
    const record = finals[0];
    if (record === undefined) throw new Error("missing final record");
    expect(record.entryId).toBe("entity_final");
    const parsed = JSON.parse(TEXT_DECODER.decode(record.bytes)) as Record<string, unknown>;
    expect(parsed.contentRef).toBe(descriptor.contentRef);
    expect(parsed.byteLength).toBe(descriptor.byteLength);
    expect(parsed.kind).toBe(descriptor.kind);
    expect(created.fatalCodes).toEqual([]);
  });

  // `final` 必须在同一批次把实体移出运行态（`live-writer.ts:288-295` 的 `target.removeEntity(entityId)`）。变更
  // 判定若只比 state vector，纯删除（只改删除集、不推进 state vector）会被静默丢弃：删除既不落库，客户端重建出的
  // 运行态还留着已封口的实体。`capture()` 改读 Yjs update 事件后两者同时成立——本用例同时断言根因与症状。
  test("T18-1b final 把实体移出运行态：纯删除当次落库，客户端重建不含该实体", async () => {
    const created = await harness();
    const runtimeDoc = created.docIds.runtime;
    created.client.hub.retain(runtimeDoc);
    await created.sendClientFrame(helloFrame(created.scope, created.generation));
    await created.sendClientFrame(subscribeFrame([runtimeDoc]));
    await created.settle();

    await created.runtime.acceptIngress({
      kind: "semantic",
      turnId: "turn-final-2",
      entryId: "entry-final-2",
      contentSlot: "0",
      contentType: "tool",
      semantic: { kind: "tool", payload: { entityId: "entity_removed", toolCallId: "tc_removed" } },
    });
    await created.settle();
    expect(extractEntities(created.reconstruct(runtimeDoc)).map((entity) => entity.entityId)).toContain(
      "entity_removed",
    );
    const afterUpsert = await created.store.readUpdatesAfter(runtimeDoc, 0, 8);
    expect(afterUpsert.length).toBe(1);

    await created.runtime.acceptIngress({
      kind: "semantic",
      turnId: "turn-final-2",
      entryId: "entry-final-2",
      contentSlot: "0",
      contentType: "tool",
      semantic: {
        kind: "final",
        payload: {
          entityId: "entity_removed",
          finalDescriptor: {
            kind: "tool",
            contentRef: "blk_acceptance_removed",
            digest: "dg_acceptance_removed",
            byteLength: 16,
            completedAt: 1_700_000_000_001,
          },
        },
      },
    });
    await created.settle();

    // 症状：客户端可见的运行态投影必须与「已终态」一致，否则封口后的实体会以幽灵条目留在运行态。
    expect(extractEntities(created.reconstruct(runtimeDoc)).map((entity) => entity.entityId)).not.toContain(
      "entity_removed",
    );
    // 根因：删除更新必须落库（upsert 1 条 + 删除 1 条），否则断线重连后旧实体复活。
    expect((await created.store.readUpdatesAfter(runtimeDoc, 0, 8)).length).toBeGreaterThanOrEqual(2);
  });

  // 缺陷 1 的第三症状（修复后的回归锁定）：删除不得依赖「该 Doc 的下一次写入」才被顺带带走——封口后长时间静默
  // 是真实会话最常见的收尾形态，延迟落库等于幽灵实体一直留在客户端与服务端投影里（删除集只挂在写者内存 Doc 上，
  // 进程一旦退出就永久丢失）。变更判定改为读 Yjs update 事件后，纯删除在封口当次即被捕获。
  // 期望：封口当次就写入删除更新，静默期结束时实体已不在运行态；后续无关写入既不复活它，也不成为删除的前提。
  test("T18-1c 封口即落库：删除不依赖后续同 Doc 写入，静默期不残留幽灵实体", async () => {
    const created = await harness();
    const runtimeDoc = created.docIds.runtime;
    created.client.hub.retain(runtimeDoc);
    await created.sendClientFrame(helloFrame(created.scope, created.generation));
    await created.sendClientFrame(subscribeFrame([runtimeDoc]));
    await created.settle();

    await created.runtime.acceptIngress({
      kind: "semantic",
      turnId: "turn-p",
      entryId: "entry-p",
      contentSlot: "0",
      contentType: "tool",
      semantic: { kind: "tool", payload: { entityId: "entity_p", toolCallId: "tc_p" } },
    });
    await created.settle();
    await created.runtime.acceptIngress({
      kind: "semantic",
      turnId: "turn-p",
      entryId: "entry-p",
      contentSlot: "0",
      contentType: "tool",
      semantic: {
        kind: "final",
        payload: {
          entityId: "entity_p",
          finalDescriptor: {
            kind: "tool",
            contentRef: "blk_p",
            digest: "dg_p",
            byteLength: 8,
            completedAt: 1_700_000_000_002,
          },
        },
      },
    });
    await created.settle();
    const afterFinal = await created.store.readUpdatesAfter(runtimeDoc, 0, 16);
    // 删除更新在封口当次落库（此前只有 1 条 upsert）：缺陷形态下此处仍是 1，删除要等下一次写入才被顺带带上。
    expect(afterFinal.length).toBeGreaterThanOrEqual(2);
    expect(extractEntities(created.reconstruct(runtimeDoc)).map((entity) => entity.entityId)).toEqual([]);

    // 第二次无关写入（error 实体）落在同一运行态 Doc 上：它不再承担「顺带带走删除」的职责，也不得复活旧实体。
    await created.runtime.acceptIngress({
      kind: "semantic",
      turnId: "turn-q",
      entryId: "entry-q",
      contentSlot: "0",
      contentType: "tool",
      semantic: { kind: "error", payload: { entityId: "entry-q", metadata: { message: "later" } } },
    });
    await created.settle();
    const afterLater = await created.store.readUpdatesAfter(runtimeDoc, 0, 16);
    expect(afterLater.length).toBeGreaterThan(afterFinal.length);
    expect(extractEntities(created.reconstruct(runtimeDoc)).map((entity) => entity.entityId)).toEqual(["entry-q"]);
  });

  // 冷重连：复用同一存储，新连接不带任何本地声明即拿全量基线，重建结果与断连前逐字节一致。
  test("T18-2 冷重连（复用存储）重建全部内容", async () => {
    const first = await connected();
    const docId = first.docIds.content;
    await writeTextEntry(first, "entry-cold", "cold-text");
    await writeTextEntry(first, "entry-cold-2", "second-text");
    await first.settle();
    const expectedTexts = textsOf(first, docId);
    expect(expectedTexts).toEqual({ "entry-cold/0": "cold-text", "entry-cold-2/0": "second-text" });
    const expectedRecords = extractRecords(first.reconstruct(docId));

    const store = first.store;
    const clock = first.clock;
    const scope = first.scope;
    const generation = first.generation;
    await first.dispose();

    const second = await harness({ clock, store, scope, generation, skipSeed: true });
    second.client.hub.retain(docId);
    await second.sendClientFrame(helloFrame(second.scope, second.generation));
    await second.sendClientFrame(subscribeFrame([docId]));
    await second.settle();

    expect(frameTypes(second.wireToClient)).toContain("BASE_READY");
    expect(second.fatalCodes).toEqual([]);
    expect(textsOf(second, docId)).toEqual(expectedTexts);
    const replayed = extractRecords(second.reconstruct(docId));
    expect(replayed.length).toBe(expectedRecords.length);
    for (const record of expectedRecords) {
      const match = replayed.find(
        (candidate) => candidate.entryId === record.entryId && candidate.partIndex === record.partIndex,
      );
      expect(match).toBeDefined();
      if (match === undefined) throw new Error(`record ${record.entryId} missing after cold reconnect`);
      expect(bytesEqual(match.bytes, record.bytes)).toBe(true);
    }
  });

  // 代次入口没有内容块时写入层按 DOC_NOT_FOUND 失败（live-writer 偏差④）：不自建块、不静默丢输入。
  test("T18-3 无内容块的代次：写入按 DOC_NOT_FOUND 失败", async () => {
    const created = await harness({ omitContentDoc: true });
    const code = await rejectionCode(() => writeTextEntry(created, "entry-no-block", "no-block"));
    expect(code).toBe("DOC_NOT_FOUND");
  });
});

describe("T19 多 Doc 驻留与队列", () => {
  // 多个内容 Doc 并发驻留：每个 Doc 各自完成基线，互不阻塞、不共享游标。
  test("T19-1 多内容 Doc 并发驻留且各自完成基线", async () => {
    const created = await connected({ seedExtraContentDocs: 2 });
    const extras = created.extraContentDocIds;
    expect(extras).toHaveLength(2);
    for (const docId of extras) created.client.hub.retain(docId);
    await created.sendClientFrame(subscribeFrame(extras));
    await created.settle();

    const docs = [created.docIds.content, ...extras];
    expect(frameTypes(created.wireToClient).filter((type) => type === "DOC_BASE")).toHaveLength(3);
    expect(frameTypes(created.wireToClient).filter((type) => type === "BASE_READY")).toHaveLength(3);
    expect(created.client.hub.queueDepth()).toBe(0);
    expect(created.fatalCodes).toEqual([]);
    for (const docId of docs) {
      expect(extractRecords(created.reconstruct(docId))).toEqual([]);
    }
  });

  // 接收队列有界：溢出按 rejected + CAPACITY_EXCEEDED 上报，不静默丢帧也不无界占用内存。
  test("T19-2 接收队列溢出：rejected 回执 + CAPACITY_EXCEEDED", async () => {
    const created = await connected();
    const docId = created.docIds.content;
    const identity = lastIdentity(created.wireToClient, docId);
    const limit = CLIENT_BUDGET.receiveQueueTasks;
    let overflowDelivery = "";
    for (let index = 1; index <= limit + 1; index += 1) {
      const deliveryId = `dl_overflow_${index}`;
      overflowDelivery = deliveryId;
      created.client.onFrame(
        wireBytes({
          type: "DOC_UPDATE",
          protocolVersion: SYNC_PROTOCOL_VERSION,
          docId,
          generation: created.generation,
          transportEpoch: identity.transportEpoch,
          subscriptionEpoch: identity.subscriptionEpoch,
          syncAttemptId: identity.syncAttemptId,
          deliveryId,
          fromSeq: index,
          toSeq: index,
          payloadDigest: `dg_overflow_${index}`,
          // `////` 是 3 个 0xFF 字节：长度必须与解码结果一致，否则在 onmessage 边界就按 MALFORMED_FRAME 失败，
          // 根本到不了接收队列（本用例要测的是队列上限，不是载荷校验）。
          encodedLength: 3,
          payload: "////",
        }),
      );
    }
    expect(created.client.hub.queueDepth()).toBe(limit);
    expect(ackResults(created.clientOutbox, overflowDelivery)).toEqual(["rejected"]);
    expect(created.fatalCodes.map((fatal) => fatal.code)).toContain("CAPACITY_EXCEEDED");
  });

  // Doc 间不串扰：写入口是入口闭包的**末位**内容块（`live-writer.loadCursor` 取 `contentDocIds.at(-1)`，
  // 即最新块），写入只落在那一个 Doc 上；同代次的其它内容块只收到自己的基线，字节里不出现任何记录。
  test("T19-3 Doc 间不串扰：只有活动内容块被写入，其余内容块保持空", async () => {
    const created = await harness({ seedExtraContentDocs: 1 });
    const inactive = created.docIds.content;
    const active = created.extraContentDocIds[0];
    if (active === undefined) throw new Error("missing extra content doc");
    created.client.hub.retain(inactive);
    created.client.hub.retain(active);
    await created.sendClientFrame(helloFrame(created.scope, created.generation));
    await created.sendClientFrame(subscribeFrame([inactive, active]));
    await created.settle();

    await writeTextEntry(created, "entry-primary", "primary-only");
    await created.settle();

    expect(textsOf(created, active)).toEqual({ "entry-primary/0": "primary-only" });
    expect(extractRecords(created.reconstruct(inactive))).toEqual([]);
    const inactiveData = framesOf(created.wireToClient).filter(
      (frame) => (frame.type === "DOC_BASE" || frame.type === "DOC_UPDATE") && stringField(frame, "docId") === inactive,
    );
    expect(inactiveData.map((frame) => frame.type)).toEqual(["DOC_BASE"]);
    // 未写入的内容块与代次登记时的空块逐字节相同：没有把别的 Doc 的更新投到它上面（reconstruct 为空记录）。
    expect(extractEntities(created.reconstruct(inactive)).length).toBe(0);
  });

  // 释放后再入队：帧被拒（unknown-doc 只结账），释放的 Doc 不会被隐式重新驻留。
  test("T19-4 release 后再次入队被拒且不重新驻留", async () => {
    const created = await connected();
    const docId = created.docIds.content;
    created.client.hub.release(docId);
    const identity = lastIdentity(created.wireToClient, docId);
    created.client.onFrame(
      wireBytes({
        type: "DOC_UPDATE",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        docId,
        generation: created.generation,
        transportEpoch: identity.transportEpoch,
        subscriptionEpoch: identity.subscriptionEpoch,
        syncAttemptId: identity.syncAttemptId,
        deliveryId: "dl_after_release",
        fromSeq: 1,
        toSeq: 1,
        payloadDigest: "dg_after_release",
        // `////` 是 3 个 0xFF 字节，`encodedLength` 必须一致，否则帧在解码阶段就被判 MALFORMED_FRAME。
        encodedLength: 3,
        payload: "////",
      }),
    );
    // 归属判定发生在队列出队时（`doc-hub.processOne`），不是入队时：必须驱动一次 apply 调度才看得到回执。
    await created.client.drain();
    expect(ackResults(created.clientOutbox, "dl_after_release")).toEqual(["rejected"]);
    expect(created.client.hub.loadedBytes()).toBe(0);
    expect(created.fatalCodes).toEqual([]);
  });
});

describe("T20 代次与换代", () => {
  // 未提交的代次不可握手：指针是唯一权威，未知代次与仍处 staging 的代次一律拒绝，不下发半成品历史。
  test("T20-1 未提交代次不可握手（未知 / staging）", async () => {
    const created = await harness();
    const unknownCode = await rejectionCode(() =>
      created.sendClientFrame(helloFrame(created.scope, "gen_acceptance_unknown")),
    );
    expect(unknownCode).toBe("GENERATION_NOT_CURRENT");

    const staging = "gen_acceptance_staging";
    const lease = await created.store.acquireWriter(created.scopeKey, "acceptance-staging", 1000);
    const refs = seededDocIdsFor(staging);
    await created.store.createGeneration({
      scopeKey: created.scopeKey,
      epoch: lease.epoch,
      generation: {
        scopeKey: created.scopeKey,
        generation: staging,
        acpSessionId: "ses_acceptance_recovery",
        loadId: "load_staging",
        state: "staging",
        importEndOrdinal: null,
        entryRefs: {
          controlDocId: refs.control,
          directoryDocId: refs.directory,
          runtimeDocId: refs.runtime,
          contentDocIds: [refs.content],
        },
        createdAt: 0,
      },
    });
    const stagingCode = await rejectionCode(() => created.sendClientFrame(helloFrame(created.scope, staging)));
    expect(stagingCode).toBe("GENERATION_NOT_CURRENT");
    expect(frameTypes(created.wireToClient)).not.toContain("MANIFEST");
  });

  // 换代必须由存储背书的修订号驱动：同修订一致重传无动作，更低修订拒（POINTER_REVISION_STALE），更高修订拒（未提交）。
  test("T20-2 GENERATION_REPLACE 的三种 revision 语义", async () => {
    const created = await harness();
    await created.sendClientFrame(helloFrame(created.scope, created.generation));
    const manifest = onlyFrame(created.wireToClient, "MANIFEST");
    const pointerRevision = manifest.fields.pointerRevision;
    expect(typeof pointerRevision).toBe("number");
    if (typeof pointerRevision !== "number") throw new Error("MANIFEST carries no pointerRevision");

    const replace = (generation: string, revision: number): SyncFrame => ({
      type: "GENERATION_REPLACE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      generation,
      pointerRevision: revision,
      referenceRevision: revision,
      controlDocId: created.docIds.control,
      directoryDocId: created.docIds.directory,
      runtimeDocId: created.docIds.runtime,
    });

    const wireBefore = created.wireToClient.length;
    await created.sendClientFrame(replace(created.generation, pointerRevision));
    await created.runtime.tick();
    expect(created.wireToClient.length).toBe(wireBefore);

    expect(await rejectionCode(() => created.sendClientFrame(replace(created.generation, pointerRevision - 1)))).toBe(
      "POINTER_REVISION_STALE",
    );
    expect(await rejectionCode(() => created.sendClientFrame(replace(created.generation, pointerRevision + 1)))).toBe(
      "GENERATION_MISMATCH",
    );
    expect(
      await rejectionCode(() =>
        created.sendClientFrame(replace("gen_acceptance_other_same_revision", pointerRevision)),
      ),
    ).toBe("GENERATION_MISMATCH");
  });

  // 换代后旧代次被隔离：新入口成套生效并可订阅，旧代次的 docId 按 GENERATION_MISMATCH 拒绝。
  test("T20-3 换代后旧代次被隔离，新入口可订阅", async () => {
    const generationA = "gen_acceptance_a";
    const generationB = "gen_acceptance_b";
    const created = await connected({ generation: generationA });
    const oldContent = created.docIds.content;

    await seedCommittedGeneration({
      store: created.store,
      scopeKey: created.scopeKey,
      generation: generationB,
      owner: "acceptance-host-b",
      leaseTtlMs: 1000,
      expectedCurrent: generationA,
      expectedPointerRevision: 1,
    });
    created.clock.advance(5000);
    const pointer = await created.store.readScopePointer(created.scopeKey);
    expect(pointer?.currentGeneration).toBe(generationB);
    expect(pointer?.pointerRevision).toBe(2);

    const next = seededDocIdsFor(generationB);
    await created.sendClientFrame({
      type: "GENERATION_REPLACE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      generation: generationB,
      pointerRevision: 2,
      referenceRevision: 2,
      controlDocId: next.control,
      directoryDocId: next.directory,
      runtimeDocId: next.runtime,
    });
    await created.settle();
    const notice = onlyFrame(created.wireToClient, "GENERATION_REPLACE");
    expect(stringField(notice, "generation")).toBe(generationB);
    expect(stringField(notice, "controlDocId")).toBe(next.control);

    created.client.hub.retain(next.content);
    await created.sendClientFrame(subscribeFrame([next.content]));
    await created.settle();
    expect(extractRecords(created.reconstruct(next.content))).toEqual([]);
    expect(created.fatalCodes).toEqual([]);

    const staleCode = await rejectionCode(() => created.sendClientFrame(subscribeFrame([oldContent])));
    expect(staleCode).toBe("GENERATION_MISMATCH");
  });
});

describe("T21 写权接管与指针单调（进程内等价物）", () => {
  // 进程内等价物：写权被接管后旧 epoch 的写操作被存储 fencing；陈旧修订的换代不改变指针（非持久化分支）。
  test("T21-1 等价物：旧 epoch 写操作被拒、陈旧修订不推进指针", async () => {
    const created = await harness();
    const first = await created.store.acquireWriter(created.scopeKey, "acceptance-fencing-a", 1000);
    created.clock.advance(5000);
    const second = await created.store.acquireWriter(created.scopeKey, "acceptance-fencing-b", 1000);
    expect(second.epoch).toBeGreaterThan(first.epoch);

    expect(await rejectionCode(() => created.store.renewWriter(first, 1000))).toBe("LEASE_EXPIRED");
    const appendCode = await rejectionCode(() =>
      created.store.appendUpdates({
        scopeKey: created.scopeKey,
        epoch: first.epoch,
        owner: "acceptance-fencing-a",
        batchId: "batch_acceptance_fencing",
        digest: "dg_acceptance_fencing",
        updates: [],
        expectedFrontiers: [],
        refs: [],
      }),
    );
    expect(appendCode).toBe("WRITER_EPOCH_LOST");

    const pointerBefore = await created.store.readScopePointer(created.scopeKey);
    const staging = "gen_acceptance_conflict";
    const refs = seededDocIdsFor(staging);
    const entryRefs = {
      controlDocId: refs.control,
      directoryDocId: refs.directory,
      runtimeDocId: refs.runtime,
      contentDocIds: [refs.content],
    };
    await created.store.createGeneration({
      scopeKey: created.scopeKey,
      epoch: second.epoch,
      generation: {
        scopeKey: created.scopeKey,
        generation: staging,
        acpSessionId: "ses_acceptance_recovery",
        loadId: "load_conflict",
        state: "staging",
        importEndOrdinal: null,
        entryRefs,
        createdAt: 0,
      },
    });
    const conflict = await created.store.commitGeneration({
      scopeKey: created.scopeKey,
      epoch: second.epoch,
      expectedCurrent: null,
      expectedPointerRevision: 0,
      newGeneration: {
        scopeKey: created.scopeKey,
        generation: staging,
        acpSessionId: "ses_acceptance_recovery",
        loadId: "load_conflict",
        state: "staging",
        importEndOrdinal: 0,
        entryRefs,
        createdAt: 0,
      },
      retired: [],
      entryClosure: entryRefs,
    });
    expect(conflict.outcome).toBe("conflict");
    const pointerAfter = await created.store.readScopePointer(created.scopeKey);
    expect(pointerAfter?.pointerRevision).toBe(pointerBefore?.pointerRevision);
    expect(pointerAfter?.currentGeneration).toBe(pointerBefore?.currentGeneration);
    const stagingRecord = await created.store.readGeneration(created.scopeKey, staging);
    expect(stagingRecord?.state).toBe("staging");
  });
});

describe("T22 容量与门禁", () => {
  // socket 水位门禁：饱和时数据帧被搁置（不上线、不报错），传输恢复后由搁置位重试补齐（`egress.ts:279-292`）。
  // 缺口在服务端被愈合，客户端从未看到序号跳跃，因此不需要换基线——`RESYNC` 只用于客户端侧真丢帧的情形，
  // 其自身路径由 T15-5（apply 失败）与 T17-2（换 attempt 后旧帧只结账）独立覆盖，本用例断言的正是「不触发」。
  test("T22-1 socket 饱和拒发数据帧，恢复后由搁置重试补齐且不必换基线", async () => {
    const created = await connected();
    const docId = created.docIds.content;
    const updatesBefore = framesWithType(created.wireToClient, "DOC_UPDATE").length;

    created.bufferedAmount = created.config.quota.socketHighWatermark;
    await writeTextEntry(created, "entry-sat-1", "sat-1");
    await created.runtime.tick();
    expect(framesWithType(created.wireToClient, "DOC_UPDATE").length).toBe(updatesBefore);

    created.bufferedAmount = 0;
    await writeTextEntry(created, "entry-sat-2", "sat-2");
    await created.settle();

    // 搁置帧在服务端补齐：线上没有缺口，客户端既不换基线也不重订阅（基线仍是最初那一条）。
    expect(framesWithType(created.wireToServer, "RESYNC").length).toBe(0);
    expect(framesWithType(created.wireToClient, "DOC_BASE").length).toBe(1);
    expect(textsOf(created, docId)).toEqual({ "entry-sat-1/0": "sat-1", "entry-sat-2/0": "sat-2" });
  });

  // 控制帧率不足（1 帧/秒，握手本身要 2 帧：HELLO + MANIFEST）：被拒帧按规格 §2.4「不抛错、只留一位有界引用、
  // 不排队」搁置，第二帧不得上线也不得绕过限流；数据面与数据帧不受控制预算牵连（两类额度独立）。
  // 半握手不会永久停留：控制类搁置不在 tick 重试（搁置 ≠ 排队重发），但搁置期限届满时 `driveWithheld()` 会做
  // 一次「最后机会」重试，仍发不出去即关连接——客户端因此不会停在一个无从察觉的半握手里（`egress.ts:283-291`）。
  test("T22-2 控制帧率不足：握手回帧被搁置，不抛错不重发，数据帧照发", async () => {
    const created = await harness({ configOverrides: { control: { framesPerSecond: 1 } } });
    await created.sendClientFrame(helloFrame(created.scope, created.generation));

    // 首帧消耗掉唯一令牌后立刻发出；第二帧（MANIFEST）被 governor 拒绝：不上线、不抛错。
    expect(frameTypes(created.wireToClient)).toEqual(["HELLO"]);
    expect(created.fatalCodes).toEqual([]);
    expect(created.controlFrames.map((frame) => frame.type)).toEqual(["HELLO"]);

    // 令牌按时间惰性补充（1/s）：推进 1 秒再 tick 也不得补发被拒帧（搁置 ≠ 排队重发）。
    const wireBefore = created.wireToClient.length;
    created.clock.advance(1000);
    await created.runtime.tick();
    expect(created.wireToClient.length).toBe(wireBefore);

    // 控制预算耗尽不牵连数据面：订阅仍能拿到 DOC_BASE（数据帧不经 governor）。
    const docId = created.docIds.content;
    created.client.hub.retain(docId);
    await created.sendClientFrame(subscribeFrame([docId]));
    expect(framesWithType(created.wireToClient, "DOC_BASE").length).toBe(1);
  });

  // dirty 上限：一次订阅超出 maxDirtyDocs 的连接自锁——既不部分生效，也不再产出任何帧。
  test("T22-3 订阅超出 dirty 上限：CAPACITY_EXCEEDED 且不部分生效", async () => {
    const created = await harness({
      seedExtraContentDocs: 2,
      configOverrides: { quota: { maxDirtyDocs: 2 } },
    });
    const docs = [created.docIds.content, ...created.extraContentDocIds];
    for (const docId of docs) created.client.hub.retain(docId);
    await created.sendClientFrame(helloFrame(created.scope, created.generation));
    const code = await rejectionCode(() => created.sendClientFrame(subscribeFrame(docs)));
    expect(code).toBe("CAPACITY_EXCEEDED");
    expect(frameTypes(created.wireToClient)).not.toContain("DOC_BASE");

    const wireBefore = created.wireToClient.length;
    await created.runtime.tick();
    expect(created.wireToClient.length).toBe(wireBefore);
  });
});

describe("T24 写者竞态与生命周期", () => {
  // 写者获取竞态：活动租约（宿主）未过期时运行时不得抢写，按 SCOPE_BUSY 失败而不是排队等待。
  test("T24-1 活动租约下 runtime 写入按 SCOPE_BUSY 失败", async () => {
    const clock = new RecoveryClock();
    const scope: SyncScope = { organizationId: "org_acceptance", rcsSessionId: "rcs_acceptance_busy" };
    const key = scopeKey(scope);
    const generation = "gen_acceptance_busy";
    const baseConfig = resolveSyncRuntimeConfig({ clock, lifecycle: LIFECYCLE });
    const store = new MemoryProjectionStore({
      clock,
      digest: sha256Digest,
      capacity: baseConfig.capacity,
      lifecycle: baseConfig.lifecycle,
    });
    await seedCommittedGeneration({ store, scopeKey: key, generation, owner: "acceptance-host", leaseTtlMs: 120_000 });
    const created = await harness({ clock, store, scope, generation, skipSeed: true });

    const code = await rejectionCode(() => writeTextEntry(created, "entry-busy", "busy"));
    expect(code).toBe("SCOPE_BUSY");
  });

  // 释放是终态：dispose 幂等，全部入口（写入、入站字节、出站绑定）都必须封闭而不是静默接受。
  test("T24-2 dispose 幂等且释放后全部入口封闭", async () => {
    const created = await connected();
    await created.dispose();
    await created.dispose();
    expect(created.outboundClosed).toBe(true);
    expect(created.serverCloseReasons.length).toBe(1);

    const writeCode = await rejectionCode(() => writeTextEntry(created, "entry-after-dispose", "x"));
    expect(writeCode).toBe("RESOURCE_RETIRED");
    const inboundCode = await rejectionCode(() =>
      created.runtime.onInboundBytes(wireBytes(helloFrame(created.scope, created.generation))),
    );
    expect(inboundCode).toBe("RESOURCE_RETIRED");
    const tickCode = await rejectionCode(() => created.runtime.tick());
    expect(tickCode).toBe("RESOURCE_RETIRED");
  });

  // 连接与 scope 一一对应：同一 scope 只允许一次出站绑定，第二次按 ADMISSION_REJECTED 拒绝。
  test("T24-3 二次 attachTransport 按 ADMISSION_REJECTED 拒绝", async () => {
    const created = await harness();
    const code = await rejectionCode(async () => {
      created.runtime.attachTransport({
        send: () => false,
        bufferedAmount: () => 0,
        close: () => {},
      });
    });
    expect(code).toBe("ADMISSION_REJECTED");
  });

  // 离线不误删：断连（ACK 超期）与 dispose 都不删除已提交内容，存储里仍能读到写入后的状态。
  test("T24-4 断连不丢已提交内容：存储仍可读出", async () => {
    const created = await connected();
    const docId = created.docIds.content;
    await writeTextEntry(created, "entry-offline", "offline-text");
    await created.runtime.tick();
    const textBefore = textsOf(created, docId);
    expect(textBefore).toEqual({ "entry-offline/0": "offline-text" });

    created.clock.advance(created.config.deadlines.ackMs + 1);
    await created.runtime.tick();
    expect(created.serverCloseReasons).toHaveLength(1);

    const state = await created.store.readDocStateAt(docId, 0);
    expect(state).not.toBeNull();
    const persisted = await created.store.readUpdatesAfter(docId, 0, 8);
    expect(persisted.length).toBeGreaterThan(0);

    await created.dispose();
    const afterDispose = await created.store.readDocStateAt(docId, 0);
    expect(afterDispose).not.toBeNull();
    expect((await created.store.readUpdatesAfter(docId, 0, 8)).length).toBe(persisted.length);
  });
});
