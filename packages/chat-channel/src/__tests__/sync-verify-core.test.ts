// packages/chat-channel/src/__tests__/sync-verify-core.test.ts
// 对抗式验证用例：不确认实现「大致正确」，而是逐条攻击设计 §4.1 / §8.3 / §9.2 / §10.1 与规格 §3~§4 的断言。
//
// 三条纪律：
// 1. 每个用例只针对一条具体断言，输入取边界值（精确字节数、多字节字符、超限标识、畸形 profile）而不是典型值；
// 2. 断言按设计原文的**最严格读法**写，发现实现达不到就保留失败并用「缺陷复现（待修复）」标注，不放宽断言；
// 3. 失败清单与可疑点写进交付报告，`file:line` 指向实现而非测试。

import { describe, expect, test } from "bun:test";
import { AdmissionController } from "../sync/capacity/admission";
import {
  CLIENT_BUDGET,
  CONCURRENCY_LIMITS,
  DEFAULT_SYNC_CAPACITY,
  INPUT_LIMITS,
  SERVER_POOL_BYTES,
  TRANSPORT_SUBPOOL_BYTES,
  validateCapacityProfile,
} from "../sync/capacity/profile";
import { type Clock, sha256Digest } from "../sync/clock";
import { type SyncErrorCode, SyncProtocolError } from "../sync/protocol/errors";
import {
  decodeSyncFrame,
  encodeSyncFrame,
  frameHeaderOf,
  type HelloFrame,
  MAX_CONTROL_FRAME_BYTES,
  MAX_DATA_FRAME_BYTES,
  MAX_FRAME_HEADER_BYTES,
  parseSyncFrame,
  type SyncFrame,
} from "../sync/protocol/frames";
import {
  assertIdentifier,
  buildDocId,
  isSameDocLineage,
  MAX_IDENTIFIER_BYTES,
  parseDocId,
  scopeKey,
} from "../sync/protocol/identity";
import { type CommittedStateSnapshot, MemoryProjectionStore } from "../sync/store/memory-store";
import type {
  AppendUpdatesInput,
  SyncDocRecord,
  SyncGenerationRecord,
  SyncRefRecord,
  WriterLease,
} from "../sync/store/types";

const TEXT_ENCODER = new TextEncoder();

/** 捕获协议错误：非 `SyncProtocolError` 原样重抛，避免把 `TypeError` 之类的实现缺陷伪装成「协议拒绝」。 */
function syncErrorOf(run: () => unknown): SyncProtocolError {
  try {
    run();
  } catch (error) {
    if (error instanceof SyncProtocolError) {
      return error;
    }
    throw error;
  }
  throw new Error("期望抛出 SyncProtocolError，但调用正常返回");
}

function expectSyncErrorCode(run: () => unknown, code: SyncErrorCode): SyncProtocolError {
  const error = syncErrorOf(run);
  expect(error.code).toBe(code);
  return error;
}

/** 异步版：拒绝且错误码一致；正常返回（含返回错误结果对象）一律判失败。 */
async function expectRejectCode(action: Promise<unknown>, code: SyncErrorCode): Promise<void> {
  const settled = await action.then(
    () => null,
    (error: unknown) => error,
  );
  expect(settled).toBeInstanceOf(SyncProtocolError);
  expect((settled as SyncProtocolError).code).toBe(code);
}

// ---------------------------------------------------------------------------
// 帧字节边界构造器：把帧撑到**精确**字节数，才可能验证「刚好卡在边界」的行为。
// ---------------------------------------------------------------------------

/** 把 total 字节分配到 count 条标识上，每条 1..MAX_IDENTIFIER_BYTES 字节。 */
function distributeIdentifierBytes(total: number, count: number): number[] {
  if (total < count || total > count * MAX_IDENTIFIER_BYTES) {
    throw new Error(`无法把 ${total} 字节分配到 ${count} 条标识（每条上限 ${MAX_IDENTIFIER_BYTES}）`);
  }
  const lengths = new Array<number>(count).fill(1);
  let rest = total - count;
  for (let index = 0; index < count && rest > 0; index += 1) {
    const add = Math.min(MAX_IDENTIFIER_BYTES - 1, rest);
    lengths[index] += add;
    rest -= add;
  }
  if (rest !== 0) {
    throw new Error("字节分配未落完，构造器自身有缺陷");
  }
  return lengths;
}

/** HELLO 骨架（空 loadedDocs）的串行化字节数，用作精确填充的基准。 */
function helloSkeleton(): HelloFrame {
  return {
    type: "HELLO",
    protocolVersion: 1,
    scope: { organizationId: "org-verify", rcsSessionId: "rcs-verify" },
    loadedDocs: [],
    stateful: false,
  };
}

/**
 * 构造精确 `totalBytes` 字节的 HELLO 控制帧。
 *
 * 唯一自由度是 loadedDocs 的 docId 长度：每条 entry 的 JSON 为 `{"docId":"…"}`，比 docId 本身多 12 字节，
 * count 条之间还有 count-1 个逗号，故总长 = 骨架 + Σlen + 13·count − 1。
 */
function helloFrameAtExactBytes(totalBytes: number): SyncFrame {
  const skeleton = helloSkeleton();
  const fixedBytes = TEXT_ENCODER.encode(JSON.stringify(skeleton)).length;
  for (let count = 1; count <= 4096; count += 1) {
    const identifierBudget = totalBytes - fixedBytes + 1 - 13 * count;
    if (identifierBudget < count || identifierBudget > count * MAX_IDENTIFIER_BYTES) {
      continue;
    }
    const frame: SyncFrame = {
      ...skeleton,
      loadedDocs: distributeIdentifierBytes(identifierBudget, count).map((length) => ({ docId: "a".repeat(length) })),
    };
    const bytes = TEXT_ENCODER.encode(JSON.stringify(frame));
    if (bytes.length !== totalBytes) {
      throw new Error(`HELLO 精确填充失败：期望 ${totalBytes}，实际 ${bytes.length}`);
    }
    return frame;
  }
  throw new Error(`无法构造 ${totalBytes} 字节的 HELLO 帧`);
}

/**
 * 构造精确 `totalBytes` 字节的 DOC_UPDATE 数据帧（含头）。
 *
 * 两个自由度联立：payload 只能按 4 字符步进（base64 长度必须是 4 的倍数），余下 0..3 字节补到 deliveryId。
 * 这里刻意让 `encodedLength` 与巨型 payload 不一致：帧层按契约不做载荷记账，本用例只攻击字节上限。
 */
function docUpdateFrameAtExactBytes(totalBytes: number): SyncFrame {
  const skeleton: SyncFrame = {
    type: "DOC_UPDATE",
    protocolVersion: 1,
    docId: buildDocId({ kind: "content", generation: "gen_verify", blockIndex: 3, nonce: "nonce-verify" }),
    generation: "gen_verify",
    transportEpoch: "tx_0123456789abcdef",
    subscriptionEpoch: "sub_0123456789abcdef",
    syncAttemptId: "att_0123456789abcdef",
    deliveryId: "d",
    fromSeq: 1,
    toSeq: 1,
    payloadDigest: sha256Digest(new Uint8Array([1])),
    encodedLength: 3,
    payload: "AAAA",
  };
  const growth = totalBytes - TEXT_ENCODER.encode(JSON.stringify(skeleton)).length;
  if (growth < 0) {
    throw new Error(`目标字节数小于 DOC_UPDATE 骨架：${totalBytes}`);
  }
  const payloadGrowth = 4 * Math.floor(growth / 4);
  const deliveryGrowth = growth - payloadGrowth;
  const frame: SyncFrame = {
    ...skeleton,
    deliveryId: "d".repeat(1 + deliveryGrowth),
    payload: "A".repeat(4 + payloadGrowth),
  };
  const bytes = TEXT_ENCODER.encode(JSON.stringify(frame));
  if (bytes.length !== totalBytes) {
    throw new Error(`DOC_UPDATE 精确填充失败：期望 ${totalBytes}，实际 ${bytes.length}`);
  }
  return frame;
}

describe("对抗验证：身份与帧契约", () => {
  // 标识上限按 UTF-8 字节计：128 个双字节字符恰好 256 字节必须通过，129 个（258 字节）必须拒绝。
  test("标识以 UTF-8 字节而非 UTF-16 码元计量：恰好 256 字节通过、越界拒绝", () => {
    const atLimit = "é".repeat(MAX_IDENTIFIER_BYTES / 2);
    expect(atLimit.length).toBe(MAX_IDENTIFIER_BYTES / 2); // 256 字节只占 128 个 UTF-16 码元
    expect(TEXT_ENCODER.encode(atLimit).length).toBe(MAX_IDENTIFIER_BYTES);
    expect(() => assertIdentifier(atLimit, "field")).not.toThrow();
    const overLimit = `${atLimit}é`;
    expectSyncErrorCode(() => assertIdentifier(overLimit, "field"), "IDENTIFIER_TOO_LONG");
    expect(TEXT_ENCODER.encode(overLimit).length).toBe(MAX_IDENTIFIER_BYTES + 2);
    expectSyncErrorCode(() => assertIdentifier("a".repeat(MAX_IDENTIFIER_BYTES + 1), "field"), "IDENTIFIER_TOO_LONG");
  });

  // scope 键的第二段必须与第一段可区分：任一段含 `/` 或为空都会让键被拆出歧义，必须拒绝。
  test("scope 任一分段为空或含分隔符时必须拒绝，不给键歧义留出口", () => {
    expect(scopeKey({ organizationId: "org-1", rcsSessionId: "rcs-1" })).toBe("org-1/rcs-1");
    expectSyncErrorCode(() => scopeKey({ organizationId: "org/1", rcsSessionId: "rcs-1" }), "MALFORMED_FRAME");
    expectSyncErrorCode(() => scopeKey({ organizationId: "org-1", rcsSessionId: "a/b" }), "MALFORMED_FRAME");
    expectSyncErrorCode(() => scopeKey({ organizationId: "", rcsSessionId: "rcs-1" }), "MALFORMED_FRAME");
    expectSyncErrorCode(() => scopeKey({ organizationId: "org-1", rcsSessionId: "rcs\u0000-1" }), "MALFORMED_FRAME");
  });

  // Yjs clientID 形态的数字标识不得被当作 docId 参与幂等或谱系：解析必须失败而不是猜一个结果。
  test("Yjs clientID 形态的标识不能进入 docId 谱系（禁止用它制造幂等）", () => {
    const clientId = "17592186044416";
    expectSyncErrorCode(() => parseDocId(clientId), "MALFORMED_FRAME");
    const valid = buildDocId({ kind: "content", generation: "gen_a", blockIndex: 0, nonce: "n-1" });
    expectSyncErrorCode(() => isSameDocLineage(clientId, valid), "MALFORMED_FRAME");
    expectSyncErrorCode(() => isSameDocLineage(valid, ""), "MALFORMED_FRAME");
  });

  // 谱系只由 kind + generation + blockIndex 决定：nonce 不同仍属同一谱系，任一维度不同即不同谱系。
  test("docId 谱系只比对 kind、generation 与 blockIndex", () => {
    const base = { generation: "gen_a", nonce: "n-1" };
    const first = buildDocId({ kind: "content", blockIndex: 7, ...base });
    const otherNonce = buildDocId({ kind: "content", generation: "gen_a", blockIndex: 7, nonce: "n-2" });
    const otherIndex = buildDocId({ kind: "content", generation: "gen_a", blockIndex: 8, nonce: "n-1" });
    const otherGeneration = buildDocId({ kind: "content", generation: "gen_b", blockIndex: 7, nonce: "n-1" });
    const otherKind = buildDocId({ kind: "directory", generation: "gen_a", blockIndex: 7, nonce: "n-1" });
    expect(isSameDocLineage(first, otherNonce)).toBe(true);
    expect(isSameDocLineage(first, otherIndex)).toBe(false);
    expect(isSameDocLineage(first, otherGeneration)).toBe(false);
    expect(isSameDocLineage(first, otherKind)).toBe(false);
  });

  // blockIndex 只接受规范十进制与安全整数：非规范写法与超出安全范围的数字必须拒绝，不能静默取整。
  test("blockIndex 拒绝非规范十进制与超出安全整数范围的序号", () => {
    const docId = (index: string) => `sync/content/gen_a/${index}/n-1`;
    expectSyncErrorCode(() => parseDocId(docId("01")), "MALFORMED_FRAME");
    expectSyncErrorCode(() => parseDocId(docId("+1")), "MALFORMED_FRAME");
    expectSyncErrorCode(() => parseDocId(docId("1.0")), "MALFORMED_FRAME");
    expectSyncErrorCode(() => parseDocId(docId(" 1")), "MALFORMED_FRAME");
    expectSyncErrorCode(() => parseDocId(docId("9007199254740993")), "MALFORMED_FRAME"); // parseInt 会舍成 2^53
    const maxSafe = buildDocId({ kind: "content", generation: "gen_a", blockIndex: 9007199254740991, nonce: "n-1" });
    expect(parseDocId(maxSafe).blockIndex).toBe(9007199254740991);
    expectSyncErrorCode(
      () => buildDocId({ kind: "content", generation: "gen_a", blockIndex: 9007199254740992, nonce: "n-1" }),
      "MALFORMED_FRAME",
    );
    expectSyncErrorCode(
      () => buildDocId({ kind: "content", generation: "gen_a", blockIndex: -1, nonce: "n-1" }),
      "MALFORMED_FRAME",
    );
  });

  // 回归：曾只校验各分段各自 ≤256 字节，产出的整体 docId 可以远超 256 字节，于是「身份层能造出来、
  // 帧层发不出去」——同一个标识上限在模块内部出现两种口径。期望：buildDocId 的产物必须能通过
  // assertIdentifier（整体 ≤256 UTF-8 字节），越过上限时直接抛 IDENTIFIER_TOO_LONG。
  test("buildDocId 必须保证整体 docId 是合法标识（≤256 字节），越过上限即拒绝", () => {
    const generation = "g".repeat(MAX_IDENTIFIER_BYTES);
    const nonce = "n".repeat(MAX_IDENTIFIER_BYTES);
    expectSyncErrorCode(() => buildDocId({ kind: "content", generation, blockIndex: 0, nonce }), "IDENTIFIER_TOO_LONG");
    const docId = buildDocId({ kind: "content", generation: "gen_a", blockIndex: 0, nonce: "nonce_a" });
    expect(TEXT_ENCODER.encode(docId).length).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
    expect(() => assertIdentifier(docId, "docId")).not.toThrow();
  });

  // 帧层标识上限同样按字节：恰好 256 字节的多字节 docId 通过，257 字节必须拒绝（总长仍远小于 32KiB）。
  test("帧层标识上限按 UTF-8 字节：256 字节的多字节 docId 通过、257 字节被拒", () => {
    const atLimit = "é".repeat(MAX_IDENTIFIER_BYTES / 2);
    const overLimit = `${atLimit}a`;
    const helloWith = (docId: string): SyncFrame => ({ ...helloSkeleton(), loadedDocs: [{ docId }] });
    const parsed = parseSyncFrame(helloWith(atLimit));
    expect(parsed.type).toBe("HELLO");
    expectSyncErrorCode(() => parseSyncFrame(helloWith(overLimit)), "MALFORMED_FRAME");
    expect(TEXT_ENCODER.encode(JSON.stringify(helloWith(overLimit))).length).toBeLessThan(MAX_CONTROL_FRAME_BYTES);
  });

  // 控制帧在 ≤32KiB 的精确边界上必须可解码且内容完整；32769 字节必须拒绝：不得「截断后当成功」。
  test("控制帧解码在 32768 字节边界通过、32769 字节拒绝且内容不被截断", () => {
    const atLimit = helloFrameAtExactBytes(MAX_CONTROL_FRAME_BYTES);
    const bytes = TEXT_ENCODER.encode(JSON.stringify(atLimit));
    expect(bytes.length).toBe(MAX_CONTROL_FRAME_BYTES);
    expect(decodeSyncFrame(bytes)).toEqual(atLimit);

    const overLimit = helloFrameAtExactBytes(MAX_CONTROL_FRAME_BYTES + 1);
    expectSyncErrorCode(() => decodeSyncFrame(TEXT_ENCODER.encode(JSON.stringify(overLimit))), "FRAME_TOO_LARGE");
    // 发送侧的头预算（4KiB）比控制帧总预算更紧：无载荷控制帧在编码阶段就被 FRAME_HEADER_TOO_LARGE 拦下，
    // 因此 32KiB 只能作为接收侧上限存在；这条断言用于固化该交互，避免有人反向放宽头预算。
    expectSyncErrorCode(() => encodeSyncFrame(atLimit), "FRAME_HEADER_TOO_LARGE");
  });

  // 数据帧含头 ≤288KiB：恰好 294912 字节必须编码并往返一致，294913 字节在编码与解码两条路径都必须拒绝。
  test("数据帧在 294912 字节边界编码并往返一致、294913 字节两条路径都拒绝", () => {
    const atLimit = docUpdateFrameAtExactBytes(MAX_DATA_FRAME_BYTES);
    if (atLimit.type !== "DOC_UPDATE") {
      throw new Error("构造器应产出 DOC_UPDATE");
    }
    expect(atLimit.payload.length).toBeGreaterThan(256 * 1024);
    const bytes = encodeSyncFrame(atLimit);
    expect(bytes.length).toBe(MAX_DATA_FRAME_BYTES);
    const decoded = decodeSyncFrame(bytes);
    expect(decoded).toEqual(atLimit);

    const overLimit = docUpdateFrameAtExactBytes(MAX_DATA_FRAME_BYTES + 1);
    expectSyncErrorCode(() => encodeSyncFrame(overLimit), "FRAME_TOO_LARGE");
    expectSyncErrorCode(() => decodeSyncFrame(TEXT_ENCODER.encode(JSON.stringify(overLimit))), "FRAME_TOO_LARGE");
  });

  // 解码前的类型探测可能被重复键误导：首键伪造为数据类时，解析后的复核必须仍按真实帧类拒绝。
  test("重复 type 键（首键伪造数据类）不能借数据帧上限放行控制类帧", () => {
    const control = helloFrameAtExactBytes(35_110);
    const { type, ...rest } = control;
    const fields = Object.entries(rest).map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`);
    const text = `{"type":"DOC_UPDATE",${fields.join(",")},"type":${JSON.stringify(type)}}`;
    const bytes = TEXT_ENCODER.encode(text);
    expect(bytes.length).toBeGreaterThan(MAX_CONTROL_FRAME_BYTES);
    expect(bytes.length).toBeLessThanOrEqual(MAX_DATA_FRAME_BYTES);
    // JSON.parse 取最后一个 type，帧对象本身是合法控制帧——若复核缺失，它会以「数据帧」身份被放行。
    expect(parseSyncFrame(JSON.parse(text)).type).toBe("HELLO");
    expectSyncErrorCode(() => decodeSyncFrame(bytes), "FRAME_TOO_LARGE");
  });

  // 超过数据帧上限的字节必须在 JSON 解析之前拒绝：用非法 JSON 做输入，错误码必须仍是 FRAME_TOO_LARGE。
  test("超过数据帧上限的字节在 JSON 解析前被拒绝（错误码证明检查顺序）", () => {
    const garbage = TEXT_ENCODER.encode(`not-json-${"x".repeat(MAX_DATA_FRAME_BYTES)}`);
    expect(garbage.length).toBeGreaterThan(MAX_DATA_FRAME_BYTES);
    expectSyncErrorCode(() => decodeSyncFrame(garbage), "FRAME_TOO_LARGE");
  });

  // 头预算按字节计：多字节标识可以把字节数顶到 4KiB 之上而码元数仍在其下，不能按码元放行。
  test("帧头预算按 UTF-8 字节计量：码元未超但字节超限时仍必须拒绝", () => {
    const docId = "中".repeat(85); // 255 字节 / 85 个码元
    const frame: SyncFrame = { ...helloSkeleton(), loadedDocs: Array.from({ length: 20 }, () => ({ docId })) };
    const headerText = JSON.stringify(frameHeaderOf(frame));
    expect(TEXT_ENCODER.encode(headerText).length).toBeGreaterThan(MAX_FRAME_HEADER_BYTES);
    expect(headerText.length).toBeLessThan(MAX_FRAME_HEADER_BYTES);
    expectSyncErrorCode(() => encodeSyncFrame(frame), "FRAME_HEADER_TOO_LARGE");
  });
});

// ---------------------------------------------------------------------------
// 容量 profile：攻击「畸形配置不得被校验放过」这一条断言。
// 校验器的正确拒绝码是 ADMISSION_REJECTED；出现 TypeError / 正常返回都算被绕过。
// ---------------------------------------------------------------------------

/** 可改写的 profile 草稿：字段仍是 number，只是去掉只读，避免用类型断言绕过被校验面。 */
interface ProfileDraft {
  serverPools: Record<string, number>;
  transportSubpools: Record<string, number>;
  inputs: Record<string, number>;
  concurrency: Record<string, number>;
  client: Record<string, number>;
  fairness: Record<string, unknown>;
}

function profileDraft(): ProfileDraft {
  return {
    serverPools: { ...SERVER_POOL_BYTES },
    transportSubpools: { ...TRANSPORT_SUBPOOL_BYTES },
    inputs: { ...INPUT_LIMITS },
    concurrency: { ...CONCURRENCY_LIMITS },
    client: { ...CLIENT_BUDGET },
    fairness: {
      historyBuilderWorkers: 2,
      builderTasksMax: 6,
      weights: { live: 8, currentHistory: 3, backgroundHistory: 1 },
      quantumBytes: 16384,
      minServiceMs: 2000,
      backgroundAggregateBytesPerSecond: 262144,
      perImportPersistBytesPerSecond: 1048576,
    },
  };
}

/** 把草稿的每一层都冻结：用于验证校验器只读，且冻结本身不会把拒绝码变成 TypeError。 */
function deepFreezeDraft(draft: ProfileDraft): ProfileDraft {
  const weights = draft.fairness.weights;
  if (typeof weights === "object" && weights !== null) {
    Object.freeze(weights);
  }
  for (const value of Object.values(draft)) {
    if (typeof value === "object" && value !== null) {
      Object.freeze(value);
    }
  }
  return Object.freeze(draft);
}

describe("对抗验证：容量预算与准入", () => {
  // 先确认草稿基线可通过校验：否则后续「拒绝」用例可能只是因为草稿本身就已经畸形。
  test("可改写草稿与默认 profile 等价，作为畸形用例的基线", () => {
    expect(() => validateCapacityProfile(profileDraft())).not.toThrow();
    expect(profileDraft().serverPools).toEqual({ ...SERVER_POOL_BYTES });
  });

  // 负值与零值即使被另一池的增量补齐到总和一致，也必须被拒绝：只比对总和的实现会放行它们。
  test("负数与零值在总和守恒的伪装下仍必须被拒绝", () => {
    const negative = profileDraft();
    negative.serverPools.frameParse = -5;
    negative.serverPools.safetyReserve += 5;
    expectSyncErrorCode(() => validateCapacityProfile(negative), "ADMISSION_REJECTED");

    const zero = profileDraft();
    zero.serverPools.safetyReserve = 0;
    zero.serverPools.frameParse += SERVER_POOL_BYTES.safetyReserve;
    expectSyncErrorCode(() => validateCapacityProfile(zero), "ADMISSION_REJECTED");

    const negativeTransport = profileDraft();
    negativeTransport.transportSubpools.socketCopy = -1;
    negativeTransport.transportSubpools.outstandingLedger += 1;
    expectSyncErrorCode(() => validateCapacityProfile(negativeTransport), "ADMISSION_REJECTED");
  });

  // NaN 与 Infinity 会污染求和比较（NaN 恒不等、Infinity 恒大于上限），必须在形状走查阶段直接拒绝。
  test("NaN 与 Infinity 不得通过整数校验", () => {
    const nan = profileDraft();
    nan.client.safetyReserveBytes = Number.NaN;
    expectSyncErrorCode(() => validateCapacityProfile(nan), "ADMISSION_REJECTED");

    const infinity = profileDraft();
    infinity.concurrency.maxConnections = Number.POSITIVE_INFINITY;
    expectSyncErrorCode(() => validateCapacityProfile(infinity), "ADMISSION_REJECTED");

    const notANumber = profileDraft();
    notANumber.inputs.jsonMaxDepth = "64" as unknown as number;
    expectSyncErrorCode(() => validateCapacityProfile(notANumber), "ADMISSION_REJECTED");
  });

  // 缺失配置必须导致拒绝启用：删掉池成员既不能变成隐式 0，也不能让求和差额成为唯一线索。
  test("缺失配置键与分组必须被拒绝，而不是退化成隐式默认值", () => {
    const missingPool = profileDraft();
    delete missingPool.serverPools.safetyReserve;
    expectSyncErrorCode(() => validateCapacityProfile(missingPool), "ADMISSION_REJECTED");

    const missingGroup = profileDraft() as unknown as Record<string, unknown>;
    delete missingGroup.transportSubpools;
    expectSyncErrorCode(() => validateCapacityProfile(missingGroup), "ADMISSION_REJECTED");

    const missingNested = profileDraft();
    delete missingNested.fairness.weights;
    expectSyncErrorCode(() => validateCapacityProfile(missingNested), "ADMISSION_REJECTED");
  });

  // 只读冻结对象：合法的冻结 profile 必须通过（校验器一旦尝试写入就会抛 TypeError），
  // 且校验前后内容一致；畸形的冻结 profile 仍必须给出协议错误码而不是类型错误。
  test("冻结 profile 通过校验且不被改写，畸形冻结 profile 仍抛 ADMISSION_REJECTED", () => {
    const frozen = deepFreezeDraft(profileDraft());
    const snapshot = JSON.stringify(frozen);
    expect(() => validateCapacityProfile(frozen)).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(snapshot);
    // 自检：本环境下写入冻结对象确实会抛 TypeError，因此「没抛」就证明校验器只读。
    expect(() => {
      frozen.serverPools.frameParse = 1;
    }).toThrow(TypeError);

    const badFrozen = profileDraft();
    badFrozen.inputs.recordHeaderMaxBytes = 8192;
    badFrozen.inputs.historyBlockTargetPayloadBytes = 262144; // 保持目标载荷 ≤ 硬限，让头上限成为唯一违规项
    deepFreezeDraft(badFrozen);
    expectSyncErrorCode(() => validateCapacityProfile(badFrozen), "ADMISSION_REJECTED");
  });

  // 池额度必须支持精确占满：恰好等于上限成功、再多 1 字节立即拒绝，且非正整数额度不得改变账目。
  test("reserve 在池上限处精确成立，越界与非正整数额度都不改变账目", () => {
    const controller = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const limit = SERVER_POOL_BYTES.safetyReserve;
    const reservation = controller.reserve("safetyReserve", limit);
    expect(controller.used("safetyReserve")).toBe(limit);
    expect(controller.available("safetyReserve")).toBe(0);
    expectSyncErrorCode(() => controller.reserve("safetyReserve", 1), "ADMISSION_REJECTED");
    expect(controller.used("safetyReserve")).toBe(limit);

    reservation.release();
    reservation.release(); // 幂等：重复释放不得让 used 变负
    expect(controller.used("safetyReserve")).toBe(0);

    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectSyncErrorCode(() => controller.reserve("historyBuild", invalid), "ADMISSION_REJECTED");
    }
    expect(controller.used("historyBuild")).toBe(0);
  });

  // 交接必须先取得目标池额度再释放原预留：目标池余额不足时原预留必须仍然有效，否则额度凭空消失。
  test("handoff 目标池余额不足时保留原预留，失败后仍可正常释放", () => {
    const controller = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const source = controller.reserve("ingressSpool", 4096);
    const blocker = controller.reserve("historyBuild", SERVER_POOL_BYTES.historyBuild - 10);
    expectSyncErrorCode(() => controller.handoff(source, "historyBuild", 20), "ADMISSION_REJECTED");
    expect(controller.used("ingressSpool")).toBe(4096); // 原预留未被释放
    expect(controller.used("historyBuild")).toBe(SERVER_POOL_BYTES.historyBuild - 10);

    source.release();
    expect(controller.used("ingressSpool")).toBe(0);
    expectSyncErrorCode(() => controller.handoff(source, "historyBuild", 1), "ADMISSION_REJECTED");
    blocker.release();
    expect(controller.used("historyBuild")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 存储：攻击「全组原子 + 读取只见已提交边界 + fencing」三条断言。
// ---------------------------------------------------------------------------

const SCOPE = "org-verify/rcs-verify";
const OTHER_SCOPE = "org-other/rcs-other";
const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;

class TestClock implements Clock {
  private current = 1_000;

  now(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

function bytesOf(value: string): Uint8Array {
  return TEXT_ENCODER.encode(value);
}

function makeStore(clock: Clock): MemoryProjectionStore {
  return new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: LIFECYCLE,
  });
}

function generationRecord(generation: string, scopeKey = SCOPE): SyncGenerationRecord {
  return {
    scopeKey,
    generation,
    acpSessionId: "acp-session",
    loadId: `load-${generation}`,
    state: "staging",
    importEndOrdinal: null,
    entryRefs: {
      controlDocId: `${generation}-control`,
      directoryDocId: `${generation}-directory`,
      runtimeDocId: `${generation}-runtime`,
      contentDocIds: [],
    },
    createdAt: 1_000,
  };
}

function docRecord(docId: string, generation = "gen-1", scopeKey = SCOPE): SyncDocRecord {
  const snapshot = bytesOf(`${docId}-snapshot`);
  return {
    scopeKey,
    generation,
    docId,
    kind: "runtime",
    state: "active",
    snapshot,
    hash: sha256Digest(snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex: null,
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  };
}

function refRecord(overrides: Partial<SyncRefRecord> = {}): SyncRefRecord {
  return {
    scopeKey: SCOPE,
    generation: "gen-1",
    lookupKind: "entry",
    lookupId: "entry-1",
    contentSlot: 0,
    partIndex: 0,
    docId: "doc-1",
    recordId: "record-1",
    orderStart: 0,
    orderEnd: 1,
    byteStart: 0,
    byteEnd: 1,
    ...overrides,
  };
}

async function setup(): Promise<{ store: MemoryProjectionStore; clock: TestClock; lease: WriterLease }> {
  const clock = new TestClock();
  const store = makeStore(clock);
  const lease = await store.acquireWriter(SCOPE, "writer-a", 100);
  await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generationRecord("gen-1") });
  return { store, clock, lease };
}

async function registerDoc(store: MemoryProjectionStore, lease: WriterLease, docId: string): Promise<void> {
  await store.createDoc({ scopeKey: SCOPE, epoch: lease.epoch, doc: docRecord(docId) });
}

function appendInput(lease: WriterLease, overrides: Partial<AppendUpdatesInput> = {}): AppendUpdatesInput {
  return {
    scopeKey: SCOPE,
    epoch: lease.epoch,
    owner: lease.owner,
    batchId: "batch-1",
    digest: "digest-1",
    expectedFrontiers: [{ docId: "doc-1", lastSeq: 0 }],
    updates: [{ docId: "doc-1", fromSeq: 1, bytes: bytesOf("update-1") }],
    ...overrides,
  };
}

describe("对抗验证：存储原子性、读取边界与 fencing", () => {
  // 缺陷复现（待修复）：refs 的校验发生在字节与前沿落地之后（memory-store.ts:288-294），
  // 于是「refs 非法」这类校验失败会留下已应用的批次：读取出口随后就能看到未提交的内容。
  // 期望：任一校验失败都必须零变化（规格 §4 第 3 条「任何一项失败时不改变任何状态」）。
  test("appendUpdates 的 refs 校验失败必须整批零变化，字节与新前沿不得先落地", async () => {
    const { store, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    await expectRejectCode(
      store.appendUpdates(appendInput(lease, { refs: [refRecord({ docId: "ghost-doc" })] })),
      "DOC_NOT_FOUND",
    );
    expect(await store.readUpdatesAfter("doc-1", 0, 10)).toEqual([]);
    expect(await store.readDocStateAt("doc-1", 0)).not.toBeNull();
  });

  // 缺陷复现（待修复）：refs 是逐条写入的，中段出现非法项时前面的索引项已经落库。
  // 期望：失败批次不得留下任何索引项（索引必须与 canonical 字节同生共死）。
  test("refs 数组中段校验失败时不得留下半写索引项", async () => {
    const { store, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    await expectRejectCode(
      store.appendUpdates(
        appendInput(lease, {
          refs: [refRecord({ lookupId: "kept" }), refRecord({ lookupId: "ghost", docId: "ghost-doc" })],
        }),
      ),
      "DOC_NOT_FOUND",
    );
    expect(await store.locateRefs({ generation: "gen-1", lookupKind: "entry", lookupId: "kept", limit: 10 })).toEqual(
      [],
    );
  });

  // 同 batchId 异摘要必须零变化；原批次被再次提交时只按幂等键回执原前沿，不得重复追加字节。
  test("同 batchId 异摘要冲突零变化，原批次的幂等重试不重复追加", async () => {
    const { store, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    const first = appendInput(lease);
    expect(await store.appendUpdates(first)).toEqual({
      outcome: "committed",
      frontiers: [{ docId: "doc-1", lastSeq: 1 }],
    });
    const before = store.exportCommittedState();

    expect(
      await store.appendUpdates(
        appendInput(lease, {
          digest: "digest-conflict",
          expectedFrontiers: [{ docId: "doc-1", lastSeq: 1 }],
          updates: [{ docId: "doc-1", fromSeq: 2, bytes: bytesOf("update-2") }],
        }),
      ),
    ).toEqual({ outcome: "conflict", frontiers: [] });
    expect(store.exportCommittedState()).toEqual(before);

    // 重试原批次：即使写前像已过期，也应按幂等键返回原前沿而不是重新校验序号。
    expect(await store.appendUpdates(first)).toEqual({
      outcome: "already-committed",
      frontiers: [{ docId: "doc-1", lastSeq: 1 }],
    });
    expect((await store.readUpdatesAfter("doc-1", 0, 10)).length).toBe(1);
  });

  // 两个批次声明同一 Doc 的同一前沿（都从 seq 1 起）：只允许一个落地，另一个必须被拒，
  // 否则同一序号会被两份不同字节抢占，读取出口就会出现「同 seq 两种内容」。
  test("同一 Doc 上声明同一前沿的并发追加只有一个批次落地，且不产生同序号两份字节", async () => {
    const { store, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    const outcomes = await Promise.allSettled([
      store.appendUpdates(
        appendInput(lease, {
          batchId: "batch-a",
          updates: [{ docId: "doc-1", fromSeq: 1, bytes: bytesOf("update-a") }],
        }),
      ),
      store.appendUpdates(
        appendInput(lease, {
          batchId: "batch-b",
          updates: [{ docId: "doc-1", fromSeq: 1, bytes: bytesOf("update-b") }],
        }),
      ),
    ]);
    expect(outcomes[0].status).toBe("fulfilled");
    expect(outcomes[1].status).toBe("rejected");
    const updates = await store.readUpdatesAfter("doc-1", 0, 10);
    expect(updates.map((update) => update.updateSeq)).toEqual([1]);
    expect(updates[0].bytes).toEqual(bytesOf("update-a"));
    expect((await store.readScopePointer(SCOPE))?.writerEpoch).toBe(lease.epoch);
  });

  // fencing 失效后旧写者迟到提交必须全面失败：追加、封口、换代、登记一个都不能成功，且状态零变化。
  test("旧 epoch 的迟到写者在 append / seal / commitGeneration / createDoc 上全部被 fencing", async () => {
    const { store, clock, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    await registerDoc(store, lease, "doc-2");
    await store.registerSuccessor({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      predecessorDocId: "doc-1",
      successorDocId: "doc-2",
      expectedLastSeq: 0,
    });
    await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generationRecord("gen-2") });

    clock.advance(100);
    const takeover = await store.acquireWriter(SCOPE, "writer-b", 100);
    expect(takeover.epoch).toBe(lease.epoch + 1);
    const before = store.exportCommittedState();

    const sealedSnapshot = bytesOf("sealed-snapshot");
    await expectRejectCode(store.appendUpdates(appendInput(lease)), "WRITER_EPOCH_LOST");
    await expectRejectCode(
      store.sealDoc({
        scopeKey: SCOPE,
        epoch: lease.epoch,
        expectedLastSeq: 0,
        docId: "doc-1",
        finalSnapshot: sealedSnapshot,
        finalHash: sha256Digest(sealedSnapshot),
        successorDocId: "doc-2",
        manifestChange: {},
      }),
      "WRITER_EPOCH_LOST",
    );
    await expectRejectCode(
      store.commitGeneration({
        scopeKey: SCOPE,
        epoch: lease.epoch,
        expectedCurrent: null,
        newGeneration: generationRecord("gen-2"),
        retired: ["gen-1"],
        entryClosure: generationRecord("gen-2").entryRefs,
        expectedPointerRevision: 0,
      }),
      "WRITER_EPOCH_LOST",
    );
    await expectRejectCode(
      store.createDoc({ scopeKey: SCOPE, epoch: lease.epoch, doc: docRecord("doc-3") }),
      "WRITER_EPOCH_LOST",
    );
    expect(store.exportCommittedState()).toEqual(before);
  });

  // 租约过期（尚无新写者）必须立即停写；同 owner 重新取得写权后 epoch 必须递增，旧凭据作废。
  test("租约过期后停写，同 owner 重取写权必须换新 epoch，旧凭据不能再续租", async () => {
    const { store, clock, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    clock.advance(100);
    await expectRejectCode(store.appendUpdates(appendInput(lease)), "LEASE_EXPIRED");

    const fresh = await store.acquireWriter(SCOPE, "writer-a", 100);
    expect(fresh.epoch).toBe(lease.epoch + 1);
    await expectRejectCode(store.appendUpdates(appendInput(lease)), "WRITER_EPOCH_LOST");
    await expectRejectCode(store.renewWriter(lease, 100), "LEASE_EXPIRED");
    expect(await store.readUpdatesAfter("doc-1", 0, 10)).toEqual([]);
  });

  // 退役代次不得继续写：换代后旧代次的文档必须拒绝追加（设计 §9.2「退役 generation 不得继续写」）。
  test("退役代次的文档必须拒绝追加", async () => {
    const { store, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generationRecord("gen-2") });
    await store.commitGeneration({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      expectedCurrent: null,
      newGeneration: generationRecord("gen-2"),
      retired: ["gen-1"],
      entryClosure: generationRecord("gen-2").entryRefs,
      expectedPointerRevision: 0,
    });
    expect((await store.readGeneration(SCOPE, "gen-1"))?.state).toBe("retired");
    await expectRejectCode(store.appendUpdates(appendInput(lease)), "RESOURCE_RETIRED");
    await expectRejectCode(
      store.createDoc({ scopeKey: SCOPE, epoch: lease.epoch, doc: docRecord("doc-late") }),
      "DOC_NOT_FOUND",
    );
    expect(await store.readUpdatesAfter("doc-1", 0, 10)).toEqual([]);
  });

  // 缺陷复现（待修复）：sealDoc 不校验代次状态（memory-store.ts:323-354），退役代次仍可封口并递增
  // pointerRevision，等于「epoch 仍有效就能继续写」——正是设计 §9.2 明令禁止的路径。
  // 期望：退役代次的文档封口必须被拒（RESOURCE_RETIRED），且 pointerRevision 不变。
  test("退役代次的文档不得继续封口，失败时 pointerRevision 不变", async () => {
    const { store, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    await registerDoc(store, lease, "doc-2");
    await store.registerSuccessor({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      predecessorDocId: "doc-1",
      successorDocId: "doc-2",
      expectedLastSeq: 0,
    });
    await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generationRecord("gen-2") });
    await store.commitGeneration({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      expectedCurrent: null,
      newGeneration: generationRecord("gen-2"),
      retired: ["gen-1"],
      entryClosure: generationRecord("gen-2").entryRefs,
      expectedPointerRevision: 0,
    });
    const pointerBefore = (await store.readScopePointer(SCOPE))?.pointerRevision;
    const sealedSnapshot = bytesOf("late-seal");
    await expectRejectCode(
      store.sealDoc({
        scopeKey: SCOPE,
        epoch: lease.epoch,
        expectedLastSeq: 0,
        docId: "doc-1",
        finalSnapshot: sealedSnapshot,
        finalHash: sha256Digest(sealedSnapshot),
        successorDocId: "doc-2",
        manifestChange: {},
      }),
      "RESOURCE_RETIRED",
    );
    expect((await store.readScopePointer(SCOPE))?.pointerRevision).toBe(pointerBefore);
  });

  // 缺陷复现（待修复）：putSealedIfAbsent 不校验代次是否登记、是否可写（memory-store.ts:299-321），
  // 未登记或已退役代次的封口文档都会被写入并立即可读，形成没有任何可写代次可达的孤儿行。
  // 期望：与 createDoc 同一规则（代次已登记且非 retired），否则拒绝。
  test("putSealedIfAbsent 必须拒绝未登记与已退役的代次，不得写入孤儿行", async () => {
    const { store, lease } = await setup();
    const snapshot = bytesOf("sealed-bytes");
    await expectRejectCode(
      store.putSealedIfAbsent({
        scopeKey: SCOPE,
        epoch: lease.epoch,
        doc: {
          ...docRecord("orphan-doc", "gen-never-registered"),
          state: "sealed",
          finalSeq: 0,
          snapshot,
          hash: sha256Digest(snapshot),
        },
      }),
      "DOC_NOT_FOUND",
    );
    expect(await store.readDocStateAt("orphan-doc", 0)).toBeNull();
    expect(await store.readGeneration(SCOPE, "gen-never-registered")).toBeNull();

    // 已登记但已退役的代次：createDoc 会拒，封口写入必须给出同一结论。
    await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generationRecord("gen-2") });
    await store.commitGeneration({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      expectedCurrent: null,
      newGeneration: generationRecord("gen-2"),
      retired: ["gen-1"],
      entryClosure: generationRecord("gen-2").entryRefs,
      expectedPointerRevision: 0,
    });
    const lateSnapshot = bytesOf("late-sealed");
    await expectRejectCode(
      store.putSealedIfAbsent({
        scopeKey: SCOPE,
        epoch: lease.epoch,
        doc: {
          ...docRecord("late-sealed", "gen-1"),
          state: "sealed",
          finalSeq: 0,
          snapshot: lateSnapshot,
          hash: sha256Digest(lateSnapshot),
        },
      }),
      "DOC_NOT_FOUND",
    );
    expect(await store.readDocStateAt("late-sealed", 0)).toBeNull();
  });

  // 缺陷复现（待修复）：docs / updates 以 docId 为唯一键（memory-store.ts:119-120、192），
  // 跨 scope 的同名 docId 会被当成「已提交」直接回 already-committed，等于跨租户静默成功。
  // 期望：行键含 scopeKey（设计 §9.1），另一个 scope 的同名 docId 必须是 conflict。
  test("跨 scope 的同名 docId 不得被当作已提交文档", async () => {
    const clock = new TestClock();
    const store = makeStore(clock);
    const leaseA = await store.acquireWriter(SCOPE, "writer-a", 100);
    await store.createGeneration({
      scopeKey: SCOPE,
      epoch: leaseA.epoch,
      generation: generationRecord("gen-1", SCOPE),
    });
    await store.createDoc({ scopeKey: SCOPE, epoch: leaseA.epoch, doc: docRecord("shared-doc", "gen-1", SCOPE) });

    const leaseB = await store.acquireWriter(OTHER_SCOPE, "writer-b", 100);
    await store.createGeneration({
      scopeKey: OTHER_SCOPE,
      epoch: leaseB.epoch,
      generation: generationRecord("gen-1", OTHER_SCOPE),
    });
    const result = await store.createDoc({
      scopeKey: OTHER_SCOPE,
      epoch: leaseB.epoch,
      doc: docRecord("shared-doc", "gen-1", OTHER_SCOPE),
    });
    expect(result.outcome).toBe("conflict");
  });

  // 读取出口不得跳洞：tail 中间缺失时，从真实前沿读取必须停在缺口而不是返回更晚的更新。
  test("readUpdatesAfter 在缺口处停止，不返回缺口之后的更新", async () => {
    const { store, clock, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    for (const seq of [1, 2, 3]) {
      await store.appendUpdates(
        appendInput(lease, {
          batchId: `batch-${seq}`,
          digest: `digest-${seq}`,
          expectedFrontiers: [{ docId: "doc-1", lastSeq: seq - 1 }],
          updates: [{ docId: "doc-1", fromSeq: seq, bytes: bytesOf(`update-${seq}`) }],
        }),
      );
    }
    const snapshot = store.exportCommittedState();
    const withGap: CommittedStateSnapshot = {
      ...snapshot,
      updates: snapshot.updates.filter((update) => update.updateSeq !== 2),
    };
    const restored = makeStore(clock);
    restored.restoreFromCommittedState(withGap);

    expect((await restored.readUpdatesAfter("doc-1", 0, 10)).map((update) => update.updateSeq)).toEqual([1]);
    expect(await restored.readUpdatesAfter("doc-1", 1, 10)).toEqual([]); // 不得跳到 3
    expect((await restored.readUpdatesAfter("doc-1", 0, 1)).map((update) => update.updateSeq)).toEqual([1]);
  });

  // readDocStateAt 只返回明确序号的 canonical 状态：中间序号必须返回 null，不得用更晚快照顶替。
  test("readDocStateAt 不得用更晚快照顶替中间序号", async () => {
    const { store, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    await registerDoc(store, lease, "doc-2");
    await store.appendUpdates(
      appendInput(lease, {
        expectedFrontiers: [{ docId: "doc-1", lastSeq: 0 }],
        updates: [{ docId: "doc-1", fromSeq: 1, bytes: bytesOf("update-1") }],
      }),
    );
    const base = await store.readDocStateAt("doc-1", 0);
    expect(base?.lastSeq).toBe(0);
    expect(await store.readDocStateAt("doc-1", 1)).toBeNull();

    await store.registerSuccessor({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      predecessorDocId: "doc-1",
      successorDocId: "doc-2",
      expectedLastSeq: 1,
    });
    const finalSnapshot = bytesOf("final-snapshot");
    await store.sealDoc({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      expectedLastSeq: 1,
      docId: "doc-1",
      finalSnapshot,
      finalHash: sha256Digest(finalSnapshot),
      successorDocId: "doc-2",
      manifestChange: {},
    });
    expect((await store.readDocStateAt("doc-1", 1))?.hash).toBe(sha256Digest(finalSnapshot));
    expect((await store.readDocStateAt("doc-1", 0))?.hash).toBe(base?.hash);
    expect(await store.readDocStateAt("doc-1", 2)).toBeNull();
  });

  // 封口与换代的失败路径必须零变化：摘要不符、写前像过期的调用不得改动目录、指针或代次记录。
  test("封口与换代的失败路径保持目录、指针与代次记录不变", async () => {
    const { store, lease } = await setup();
    await registerDoc(store, lease, "doc-1");
    await registerDoc(store, lease, "doc-2");
    await store.registerSuccessor({
      scopeKey: SCOPE,
      epoch: lease.epoch,
      predecessorDocId: "doc-1",
      successorDocId: "doc-2",
      expectedLastSeq: 0,
    });
    await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generationRecord("gen-2") });
    const before = store.exportCommittedState();
    const pointerBefore = (await store.readScopePointer(SCOPE))?.pointerRevision;

    await expectRejectCode(
      store.sealDoc({
        scopeKey: SCOPE,
        epoch: lease.epoch,
        expectedLastSeq: 0,
        docId: "doc-1",
        finalSnapshot: bytesOf("snapshot-a"),
        finalHash: sha256Digest(bytesOf("snapshot-b")),
        successorDocId: "doc-2",
        manifestChange: {},
      }),
      "DIGEST_CONFLICT",
    );
    expect(
      await store.commitGeneration({
        scopeKey: SCOPE,
        epoch: lease.epoch,
        expectedCurrent: null,
        newGeneration: generationRecord("gen-2"),
        retired: ["gen-1"],
        entryClosure: generationRecord("gen-2").entryRefs,
        expectedPointerRevision: 7,
      }),
    ).toEqual({ outcome: "conflict", currentGeneration: "", pointerRevision: pointerBefore ?? 0 });

    const pointerAfter = await store.readScopePointer(SCOPE);
    expect(pointerAfter?.currentGeneration).toBeNull();
    expect(pointerAfter?.pointerRevision).toBe(pointerBefore);
    expect((await store.readGeneration(SCOPE, "gen-2"))?.state).toBe("staging");
    expect((await store.readDirectory({ generation: "gen-1", limit: 10 })).entries).toEqual([]);
    expect(store.exportCommittedState()).toEqual(before);
  });
});
