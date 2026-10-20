import { describe, expect, test } from "bun:test";
import { sha256Digest } from "../sync/clock";
import { type SyncErrorCode, SyncProtocolError } from "../sync/protocol/errors";
import {
  decodeSyncFrame,
  encodeSyncFrame,
  frameClassOf,
  frameHeaderOf,
  MAX_CONTROL_FRAME_BYTES,
  MAX_DATA_FRAME_BYTES,
  MAX_DOC_SNAPSHOT_BYTES,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_FRAME_HEADER_BYTES,
  MAX_SEALED_DEPENDS_ON,
  parseSyncFrame,
  SYNC_PROTOCOL_VERSION,
  type SyncFrame,
} from "../sync/protocol/frames";
import { buildDocId } from "../sync/protocol/identity";

/** 捕获本层协议错误，便于核对错误码；非本层异常原样抛出以免掩盖缺陷。 */
function captureSyncError(run: () => unknown): SyncProtocolError {
  try {
    run();
  } catch (error) {
    if (error instanceof SyncProtocolError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected SyncProtocolError to be thrown");
}

function expectSyncErrorCode(run: () => unknown, code: SyncErrorCode): SyncProtocolError {
  const error = captureSyncError(run);
  expect(error.code).toBe(code);
  return error;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8");

/** 载荷按标准 base64 编码：schema 只接受这一种形态（浏览器 `atob` 亦然）。 */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** 确定性字节序列：测试只关心长度与可往返性，不需要真实随机性。 */
function payloadOf(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 31 + 7) % 256;
  }
  return bytes;
}

const GENERATION = "gen_0123456789abcdef0123456789abcdef";
const CONTENT_DOC_ID = buildDocId({ kind: "content", generation: GENERATION, blockIndex: 3, nonce: "nonce-a" });
const DIRECTORY_DOC_ID = buildDocId({ kind: "directory", generation: GENERATION, blockIndex: 0, nonce: "nonce-b" });
const CONTROL_DOC_ID = buildDocId({ kind: "control", generation: GENERATION, blockIndex: 0, nonce: "nonce-c" });
const RUNTIME_DOC_ID = buildDocId({ kind: "runtime", generation: GENERATION, blockIndex: 0, nonce: "nonce-d" });
const TRANSPORT_EPOCH = "tx_0123456789abcdef";
const SUBSCRIPTION_EPOCH = "sub_0123456789abcdef";
const SYNC_ATTEMPT_ID = "att_0123456789abcdef";
const DELIVERY_ID = "dlv_0123456789abcdef";
const SCOPE = { organizationId: "org-1", rcsSessionId: "rcs_session1" };
const PAYLOAD = payloadOf(64);
const PAYLOAD_BASE64 = toBase64(PAYLOAD);
const PAYLOAD_DIGEST = sha256Digest(PAYLOAD);
const SNAPSHOT_DIGEST = sha256Digest(payloadOf(128));

/** 11 类帧各一个合法样例：往返与严格性回归的共同输入。 */
function buildValidFrames(): SyncFrame[] {
  const dataHeader = {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    docId: CONTENT_DOC_ID,
    generation: GENERATION,
    transportEpoch: TRANSPORT_EPOCH,
    subscriptionEpoch: SUBSCRIPTION_EPOCH,
    syncAttemptId: SYNC_ATTEMPT_ID,
    deliveryId: DELIVERY_ID,
    payloadDigest: PAYLOAD_DIGEST,
    encodedLength: PAYLOAD.length,
    payload: PAYLOAD_BASE64,
  } as const;
  return [
    {
      type: "HELLO",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      scope: SCOPE,
      generation: GENERATION,
      loadedDocs: [
        {
          docId: CONTENT_DOC_ID,
          subscriptionEpoch: SUBSCRIPTION_EPOCH,
          syncAttemptId: SYNC_ATTEMPT_ID,
          lastAppliedSeq: 12,
        },
      ],
      stateful: true,
    },
    {
      type: "MANIFEST",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      generation: GENERATION,
      pointerRevision: 4,
      referenceRevision: 2,
      controlDocId: CONTROL_DOC_ID,
      runtimeDocId: RUNTIME_DOC_ID,
      directoryDocId: DIRECTORY_DOC_ID,
      recoveryState: "ready",
    },
    {
      type: "SUBSCRIBE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docIds: [CONTENT_DOC_ID, DIRECTORY_DOC_ID],
      priority: "live",
    },
    { type: "DOC_BASE", ...dataHeader, baseSeq: 0, mode: "full" },
    {
      type: "BASE_READY",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docId: CONTENT_DOC_ID,
      generation: GENERATION,
      transportEpoch: TRANSPORT_EPOCH,
      subscriptionEpoch: SUBSCRIPTION_EPOCH,
      syncAttemptId: SYNC_ATTEMPT_ID,
      baseSeq: 0,
    },
    { type: "DOC_UPDATE", ...dataHeader, fromSeq: 1, toSeq: 4 },
    {
      type: "SEALED",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docId: CONTENT_DOC_ID,
      generation: GENERATION,
      subscriptionEpoch: SUBSCRIPTION_EPOCH,
      syncAttemptId: SYNC_ATTEMPT_ID,
      finalSeq: 9,
      snapshotDigest: SNAPSHOT_DIGEST,
      dependsOn: [DIRECTORY_DOC_ID],
    },
    {
      type: "APPLY_ACK",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      transportEpoch: TRANSPORT_EPOCH,
      deliveryId: DELIVERY_ID,
      result: "processed",
      docId: CONTENT_DOC_ID,
      appliedSeq: 4,
    },
    {
      type: "RESYNC",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docId: CONTENT_DOC_ID,
      generation: GENERATION,
      previousSubscriptionEpoch: SUBSCRIPTION_EPOCH,
      previousSyncAttemptId: SYNC_ATTEMPT_ID,
      attemptId: "att_fedcba9876543210",
    },
    {
      type: "GENERATION_REPLACE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      generation: GENERATION,
      pointerRevision: 5,
      referenceRevision: 3,
      controlDocId: CONTROL_DOC_ID,
      directoryDocId: DIRECTORY_DOC_ID,
      runtimeDocId: RUNTIME_DOC_ID,
    },
    {
      type: "ERROR",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      code: "MALFORMED_FRAME",
      retryable: false,
      scope: "org-1/rcs_session1",
      generation: GENERATION,
      docId: CONTENT_DOC_ID,
      message: "frame rejected",
    },
  ];
}

/** 组装一条超大 HELLO：加载条目数量使它必然越过控制帧上限，但结构仍然合法。 */
function buildOversizedHelloFrame(): SyncFrame {
  return {
    type: "HELLO",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    scope: SCOPE,
    loadedDocs: Array.from({ length: 500 }, (_unused, index) => ({
      docId: CONTENT_DOC_ID,
      subscriptionEpoch: SUBSCRIPTION_EPOCH,
      syncAttemptId: SYNC_ATTEMPT_ID,
      lastAppliedSeq: index,
    })),
    stateful: true,
  };
}

/** 组装一条数据帧：`payloadBytes` 决定 base64 载荷长度，用来试探数据帧字节边界。 */
function buildLargeDocBaseFrame(payloadBytes: number): SyncFrame {
  const huge = payloadOf(payloadBytes);
  return {
    type: "DOC_BASE",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    docId: CONTENT_DOC_ID,
    generation: GENERATION,
    transportEpoch: TRANSPORT_EPOCH,
    subscriptionEpoch: SUBSCRIPTION_EPOCH,
    syncAttemptId: SYNC_ATTEMPT_ID,
    deliveryId: DELIVERY_ID,
    baseSeq: 0,
    mode: "full",
    payloadDigest: sha256Digest(huge),
    encodedLength: huge.length,
    payload: toBase64(huge),
  };
}

function expectFrameMismatch(input: unknown): void {
  expectSyncErrorCode(() => parseSyncFrame(input), "MALFORMED_FRAME");
}

describe("帧编解码与字节预算", () => {
  // 每类帧都必须无损往返：schema 与 JSON 编解码是线上帧的唯一形态契约，任一帧漂移都等于断连。
  test("11 类帧编解码往返一致且帧类稳定", () => {
    const frames = buildValidFrames();
    expect(frames.length).toBe(11);
    for (const frame of frames) {
      const bytes = encodeSyncFrame(frame);
      const decoded = decodeSyncFrame(bytes);
      expect(decoded).toEqual(frame);
      expect(frameClassOf(decoded)).toBe(frameClassOf(frame));
      expect(parseSyncFrame(JSON.parse(TEXT_DECODER.decode(bytes)))).toEqual(frame);
    }
  });

  // 控制帧上限 32KiB 必须在 JSON 解析前生效：超大控制帧不得靠「schema 恰好通过」进入后续流程。
  test("控制帧超过 32KiB 被拒绝", () => {
    const frame = buildOversizedHelloFrame();
    const bytes = TEXT_ENCODER.encode(JSON.stringify(frame));
    expect(bytes.length).toBeGreaterThan(MAX_CONTROL_FRAME_BYTES);
    expect(bytes.length).toBeLessThanOrEqual(MAX_DATA_FRAME_BYTES);
    expectSyncErrorCode(() => decodeSyncFrame(bytes), "FRAME_TOO_LARGE");
    expectSyncErrorCode(() => decodeSyncFrame(bytes.subarray(0, MAX_DATA_FRAME_BYTES + 1)), "FRAME_TOO_LARGE");
  });

  // 头预算 4KiB 独立于总预算：头超限必须在编码前失败，先编码再失败会把超大帧整块摊进内存。
  test("帧头超过 4KiB 被拒绝", () => {
    const frame = buildOversizedHelloFrame();
    const headerBytes = TEXT_ENCODER.encode(JSON.stringify(frameHeaderOf(frame))).length;
    expect(headerBytes).toBeGreaterThan(MAX_FRAME_HEADER_BYTES);
    expectSyncErrorCode(() => encodeSyncFrame(frame), "FRAME_HEADER_TOO_LARGE");
  });

  // 可传输不变量：最大快照叠加最长合法标识后，仍必须能被单帧完整编码并解码。
  test("MAX_DOC_SNAPSHOT_BYTES 与 256 字节标识组合仍在数据帧上限内", () => {
    const identifier = "i".repeat(256);
    const frame: SyncFrame = {
      ...buildLargeDocBaseFrame(MAX_DOC_SNAPSHOT_BYTES),
      docId: identifier,
      generation: identifier,
      transportEpoch: identifier,
      subscriptionEpoch: identifier,
      syncAttemptId: identifier,
      deliveryId: identifier,
      payloadDigest: identifier,
    };
    const bytes = encodeSyncFrame(frame);
    expect(bytes.length).toBeLessThanOrEqual(MAX_DATA_FRAME_BYTES);
    expect(decodeSyncFrame(bytes)).toEqual(frame);
  });

  // 数据帧放宽到 288KiB（含 base64 载荷）但不得越界：这是历史快照跨 WS 分片的物理上限。
  test("数据帧允许到 288KiB 且超限被拒绝", () => {
    const frame = buildLargeDocBaseFrame(180 * 1024);
    const bytes = encodeSyncFrame(frame);
    expect(bytes.length).toBeGreaterThan(MAX_CONTROL_FRAME_BYTES);
    expect(bytes.length).toBeLessThanOrEqual(MAX_DATA_FRAME_BYTES);
    // 载荷在帧头核算之外：头仍远小于 4KiB，证明大载荷不会被误判成头超限。
    expect(TEXT_ENCODER.encode(JSON.stringify(frameHeaderOf(frame))).length).toBeLessThanOrEqual(
      MAX_FRAME_HEADER_BYTES,
    );
    const decoded = decodeSyncFrame(bytes);
    expect(decoded).toEqual(frame);

    const oversized = buildLargeDocBaseFrame(220 * 1024);
    const oversizedBytes = TEXT_ENCODER.encode(JSON.stringify(oversized));
    expect(oversizedBytes.length).toBeGreaterThan(MAX_DATA_FRAME_BYTES);
    expectSyncErrorCode(() => encodeSyncFrame(oversized), "FRAME_TOO_LARGE");
    expectSyncErrorCode(() => decodeSyncFrame(oversizedBytes), "FRAME_TOO_LARGE");
  });

  // 判别字段可能不在开头（键序跟随生产者插入顺序）：类型探测必须仍然放宽到数据帧上限。
  test("载荷排在 type 之前的大数据帧仍可解码", () => {
    const frame = buildLargeDocBaseFrame(180 * 1024);
    if (frame.type !== "DOC_BASE") {
      throw new Error("expected DOC_BASE sample");
    }
    // 先插入 payload：其余字段在它之后展开，于是判别字段确实排在载荷之后。
    const { payload, ...rest } = frame;
    const text = JSON.stringify({ payload, ...rest });
    expect(text.indexOf('"type"')).toBeGreaterThan(MAX_CONTROL_FRAME_BYTES);
    expect(decodeSyncFrame(TEXT_ENCODER.encode(text)).type).toBe("DOC_BASE");
  });

  // 空字节、非 JSON 与非法 UTF-8 都是畸形输入：必须给协议错误，不能让底层异常穿透或替换字符掩盖损坏。
  test("空字节、非 JSON 与非法 UTF-8 被拒绝", () => {
    expectSyncErrorCode(() => decodeSyncFrame(new Uint8Array(0)), "MALFORMED_FRAME");
    expectSyncErrorCode(() => decodeSyncFrame(TEXT_ENCODER.encode("not json")), "MALFORMED_FRAME");
    expectSyncErrorCode(() => decodeSyncFrame(TEXT_ENCODER.encode('{"type":"HELLO"')), "MALFORMED_FRAME");
    expectSyncErrorCode(() => decodeSyncFrame(new Uint8Array([0xff, 0xfe, 0xfd, 0x00])), "MALFORMED_FRAME");
  });
});

describe("严格 schema", () => {
  // 未知字段必须被拒绝：静默接受未知字段会让协议演进失去握手协商的意义，也会掩盖字段拼写错误。
  test("顶层与嵌套多余字段被拒绝", () => {
    const hello = buildValidFrames()[0];
    expectFrameMismatch({ ...hello, extra: true });
    expectFrameMismatch({ ...hello, scope: { ...SCOPE, extra: true } });
    expectFrameMismatch({
      ...hello,
      loadedDocs: [{ docId: CONTENT_DOC_ID, lastAppliedSeq: 1, extra: true }],
    });
    expectFrameMismatch({ type: "SUBSCRIBE", protocolVersion: SYNC_PROTOCOL_VERSION, docIds: [], priority: "urgent" });
  });

  // 未知帧类型与非本协议的协议版本都不是「默认控制帧」：类型必须显式分类，版本必须显式协商。
  test("未知帧类型与错误协议版本被拒绝", () => {
    expectFrameMismatch({ type: "UNKNOWN", protocolVersion: SYNC_PROTOCOL_VERSION });
    expectFrameMismatch({ ...buildValidFrames()[0], protocolVersion: SYNC_PROTOCOL_VERSION + 1 });
    expectFrameMismatch(null);
    expectFrameMismatch([]);
    expectSyncErrorCode(() => frameClassOf({ type: "UNKNOWN" } as unknown as SyncFrame), "MALFORMED_FRAME");
  });

  // dependsOn 上限 8：超限必须拒绝而不是截断，截断会静默丢掉依赖并让客户端误判内容完整。
  test("SEALED.dependsOn 上限为 8", () => {
    const sealed = buildValidFrames().find((frame) => frame.type === "SEALED");
    if (sealed === undefined) {
      throw new Error("SEALED sample is missing");
    }
    expect(sealed.dependsOn.length).toBeLessThanOrEqual(MAX_SEALED_DEPENDS_ON);
    expect(parseSyncFrame({ ...sealed, dependsOn: Array.from({ length: 8 }, () => DIRECTORY_DOC_ID) })).toEqual({
      ...sealed,
      dependsOn: Array.from({ length: 8 }, () => DIRECTORY_DOC_ID),
    });
    expectFrameMismatch({ ...sealed, dependsOn: Array.from({ length: 9 }, () => DIRECTORY_DOC_ID) });
  });

  // ERROR.message 上限 200 字符：超限说明调用方把正文塞进了诊断字段，必须显式失败而不是静默截断。
  test("ERROR.message 长度与字符集受限", () => {
    const errorFrame = buildValidFrames().find((frame) => frame.type === "ERROR");
    if (errorFrame === undefined) {
      throw new Error("ERROR sample is missing");
    }
    expect(parseSyncFrame({ ...errorFrame, message: "x".repeat(MAX_ERROR_MESSAGE_CHARS) })).toEqual({
      ...errorFrame,
      message: "x".repeat(MAX_ERROR_MESSAGE_CHARS),
    });
    expectFrameMismatch({ ...errorFrame, message: "x".repeat(MAX_ERROR_MESSAGE_CHARS + 1) });
    expectFrameMismatch({ ...errorFrame, message: "line1\nline2" });
    expectFrameMismatch({ ...errorFrame, code: "NOT_A_SYNC_CODE" });
  });

  // 载荷只接受标准 base64：url-safe 或不带填充的变体会让浏览器 `atob` 静默失败或解出错误字节。
  test("payload 必须是标准 base64", () => {
    const base = buildValidFrames().find((frame) => frame.type === "DOC_BASE");
    if (base === undefined) {
      throw new Error("DOC_BASE sample is missing");
    }
    expect(parseSyncFrame({ ...base, payload: "" })).toEqual({ ...base, payload: "" });
    expectFrameMismatch({ ...base, payload: PAYLOAD_BASE64.replace(/=+$/, "") });
    expectFrameMismatch({ ...base, payload: "a-b_c=" });
    expectFrameMismatch({ ...base, payload: "not base64!" });
  });

  // 单标识上限 256 字节（UTF-8）：超长标识会挤占头部预算并让日志与键失序，必须在帧层就拒绝。
  test("标识超过 256 字节被拒绝", () => {
    const base = buildValidFrames().find((frame) => frame.type === "BASE_READY");
    if (base === undefined) {
      throw new Error("BASE_READY sample is missing");
    }
    expect(parseSyncFrame({ ...base, docId: "a".repeat(256) })).toEqual({ ...base, docId: "a".repeat(256) });
    expectFrameMismatch({ ...base, docId: "a".repeat(257) });
    expectFrameMismatch({ ...base, docId: "é".repeat(129) });
    expectFrameMismatch({ ...base, docId: "" });
  });
});

describe("帧类与帧头", () => {
  // 帧类决定适用哪一档字节上限：分类错误会让控制帧拿到数据帧的宽松额度。
  test("frameClassOf 区分控制帧与数据帧", () => {
    const dataTypes = new Set(["DOC_BASE", "DOC_UPDATE"]);
    for (const frame of buildValidFrames()) {
      expect(frameClassOf(frame)).toBe(dataTypes.has(frame.type) ? "data" : "control");
    }
  });

  // 帧头核算必须排除 payload 与 message，且返回浅拷贝：调用方的改写不得污染待发送或待解析的帧。
  test("frameHeaderOf 去掉 payload 与 message 且不与原帧共享顶层字段", () => {
    const base = buildValidFrames().find((frame) => frame.type === "DOC_BASE");
    const errorFrame = buildValidFrames().find((frame) => frame.type === "ERROR");
    if (base === undefined || errorFrame === undefined) {
      throw new Error("frame samples are missing");
    }
    const baseHeader = frameHeaderOf(base);
    expect(baseHeader.payload).toBeUndefined();
    expect(baseHeader.docId).toBe(CONTENT_DOC_ID);
    baseHeader.docId = "tampered";
    expect(base.docId).toBe(CONTENT_DOC_ID);

    const errorHeader = frameHeaderOf(errorFrame);
    expect(errorHeader.message).toBeUndefined();
    expect(errorHeader.code).toBe("MALFORMED_FRAME");
  });
});
