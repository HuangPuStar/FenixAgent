import { describe, expect, test } from "bun:test";
import { cryptoRandomSource, deterministicRandomSource, sha256Digest } from "../sync/clock";
import { type SyncErrorCode, SyncProtocolError } from "../sync/protocol/errors";
import {
  assertIdentifier,
  assertMonotonicSeq,
  buildDocId,
  createBatchId,
  createDeliveryId,
  createGenerationId,
  createLoadId,
  createSubscriptionEpoch,
  createSyncAttemptId,
  createTransportEpoch,
  type DocIdParts,
  isSameDocLineage,
  MAX_IDENTIFIER_BYTES,
  parseDocId,
  scopeKey,
} from "../sync/protocol/identity";

/** 捕获本层协议错误，便于核对错误码与安全上下文；非本层异常原样抛出以免掩盖缺陷。 */
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

describe("标识校验", () => {
  // 上限按 UTF-8 字节计（多字节字符不能用 UTF-16 码元折算）：256 字节是允许边界，超出即超长。
  test("按 UTF-8 字节数拒绝超长标识", () => {
    expect(() => assertIdentifier("a".repeat(MAX_IDENTIFIER_BYTES), "field")).not.toThrow();
    expect(() => assertIdentifier("é".repeat(128), "field")).not.toThrow();
    expectSyncErrorCode(() => assertIdentifier("a".repeat(257), "field"), "IDENTIFIER_TOO_LONG");
    expectSyncErrorCode(() => assertIdentifier("é".repeat(129), "field"), "IDENTIFIER_TOO_LONG");
  });

  // 空标识、控制字符（NUL / DEL / C1）属于畸形输入；错误信息只带字段名，不回显可能含凭据的原值。
  test("拒绝空标识与控制字符且不回显原值", () => {
    expectSyncErrorCode(() => assertIdentifier("", "field"), "MALFORMED_FRAME");
    expectSyncErrorCode(() => assertIdentifier("a\u0000b", "field"), "MALFORMED_FRAME");
    expectSyncErrorCode(() => assertIdentifier("a\u007fb", "field"), "MALFORMED_FRAME");
    expectSyncErrorCode(() => assertIdentifier("a\u009bb", "field"), "MALFORMED_FRAME");

    const error = captureSyncError(() => assertIdentifier(`token=SECRET-${"x".repeat(300)}`, "field"));
    expect(error.message).not.toContain("SECRET");
    expect(JSON.stringify(error.safeContext)).not.toContain("SECRET");
  });

  // scopeKey 以 `/` 拼接两个字段，字段自身含 `/` 会让键拆出多于两段而不可反解，必须拒绝。
  test("scopeKey 拼接两个字段并拒绝含分隔符的字段", () => {
    expect(scopeKey({ organizationId: "org-1", rcsSessionId: "rcs_abc" })).toBe("org-1/rcs_abc");
    expectSyncErrorCode(() => scopeKey({ organizationId: "org/1", rcsSessionId: "rcs_abc" }), "MALFORMED_FRAME");
    expectSyncErrorCode(() => scopeKey({ organizationId: "org-1", rcsSessionId: "rcs/abc" }), "MALFORMED_FRAME");
  });
});

describe("标识生成器", () => {
  // 前缀与随机段长度是帧头解析与日志识别的前提；随机性只来自注入源，同一 seed 必须得到同一序列。
  test("生成固定前缀与长度的标识且随机性来自注入源", () => {
    const rand = deterministicRandomSource("identity-generators");
    expect(createGenerationId(rand)).toMatch(/^gen_[0-9a-f]{32}$/);
    expect(createLoadId(rand)).toMatch(/^load_[0-9a-f]{32}$/);
    expect(createBatchId(rand)).toMatch(/^batch_[0-9a-f]{32}$/);
    expect(createTransportEpoch(rand)).toMatch(/^tx_[0-9a-f]{16}$/);
    expect(createSubscriptionEpoch(rand)).toMatch(/^sub_[0-9a-f]{16}$/);
    expect(createSyncAttemptId(rand)).toMatch(/^att_[0-9a-f]{16}$/);
    expect(createDeliveryId(rand)).toMatch(/^dlv_[0-9a-f]{16}$/);

    expect(createGenerationId(deterministicRandomSource("seed-a"))).toBe(
      createGenerationId(deterministicRandomSource("seed-a")),
    );
    expect(createGenerationId(deterministicRandomSource("seed-a"))).not.toBe(
      createGenerationId(deterministicRandomSource("seed-b")),
    );
  });

  // 同一随机源的连续调用必须推进游标，否则一次运行内会生成重复标识并破坏幂等键的唯一性。
  test("同一随机源的连续调用不重复", () => {
    const rand = deterministicRandomSource("sequence");
    const ids = new Set(Array.from({ length: 64 }, () => createGenerationId(rand)));
    expect(ids.size).toBe(64);
  });
});

describe("docId", () => {
  // docId 按 sync/<kind>/<generation>/<index>/<nonce> 组装，必须能逐字段无损往返解析。
  test("组装与解析双向一致", () => {
    const cases: DocIdParts[] = [
      { kind: "control", generation: "gen_0011", blockIndex: 0, nonce: "tx_aa" },
      { kind: "content", generation: "gen_ff", blockIndex: 12, nonce: "dlv_bb" },
      { kind: "directory", generation: "gen_cc", blockIndex: 3, nonce: "n-1" },
      { kind: "runtime", generation: "gen_dd", blockIndex: 0, nonce: "n_2" },
    ];
    for (const parts of cases) {
      const docId = buildDocId(parts);
      expect(docId).toBe(`sync/${parts.kind}/${parts.generation}/${parts.blockIndex}/${parts.nonce}`);
      expect(parseDocId(docId)).toEqual({ ...parts });
    }
  });

  // docId 属于不可信输入：段数、前缀、kind、段内容与序号任一不合规都必须整体拒绝，不猜部分字段。
  test("拒绝畸形 docId", () => {
    const malformed = [
      "",
      "sync",
      "sync/content/gen_1",
      "sync/content/gen_1/0",
      "sync/content/gen_1/0/nonce/extra",
      "content/gen_1/0/nonce",
      "sync/unknown/gen_1/0/nonce",
      "sync/content//0/nonce",
      "sync/content/gen_1/0/",
      "sync/content/gen_1/-1/nonce",
      "sync/content/gen_1/01/nonce",
      "sync/content/gen_1/ 0/nonce",
      "sync/content/gen_1/1.0/nonce",
      `sync/content/gen_1/${"9".repeat(400)}/nonce`,
      "sync/content/gen_1/0/non\u0000ce",
      "sync/content/gen\u001b[31m/0/nonce",
      `sync/content/${"g".repeat(300)}/0/nonce`,
    ];
    for (const docId of malformed) {
      expectSyncErrorCode(() => parseDocId(docId), "MALFORMED_FRAME");
    }
  });

  // 谱系只由 kind+generation+blockIndex 决定，nonce 不同仍属同一谱系；畸形输入必须抛错而非猜结论。
  test("谱系比较只看 kind、generation 与 blockIndex", () => {
    expect(isSameDocLineage("sync/content/gen_a/3/n1", "sync/content/gen_a/3/n2")).toBe(true);
    expect(isSameDocLineage("sync/content/gen_a/3/n1", "sync/content/gen_a/4/n1")).toBe(false);
    expect(isSameDocLineage("sync/content/gen_a/3/n1", "sync/content/gen_b/3/n1")).toBe(false);
    expect(isSameDocLineage("sync/content/gen_a/3/n1", "sync/directory/gen_a/3/n1")).toBe(false);
    expectSyncErrorCode(() => isSameDocLineage("sync/content/gen_a/3/n1", "sync/content/gen_a/3"), "MALFORMED_FRAME");
  });
});

describe("序号连续性", () => {
  // 只接受 prev+1，或从空游标（prev=0）取 0/1 起点；跳号、回退与非整数一律 SEQUENCE_GAP。
  test("只接受连续序号与 0/1 起点", () => {
    expect(() => assertMonotonicSeq(1, 0)).not.toThrow();
    expect(() => assertMonotonicSeq(0, 0)).not.toThrow();
    expect(() => assertMonotonicSeq(4, 3)).not.toThrow();

    expectSyncErrorCode(() => assertMonotonicSeq(2, 0), "SEQUENCE_GAP");
    expectSyncErrorCode(() => assertMonotonicSeq(5, 3), "SEQUENCE_GAP");
    expectSyncErrorCode(() => assertMonotonicSeq(3, 3), "SEQUENCE_GAP");
    expectSyncErrorCode(() => assertMonotonicSeq(4, 5), "SEQUENCE_GAP");
    expectSyncErrorCode(() => assertMonotonicSeq(-1, 0), "SEQUENCE_GAP");
    expectSyncErrorCode(() => assertMonotonicSeq(2.5, 1.5), "SEQUENCE_GAP");
  });
});

describe("时间、随机与摘要基础契约", () => {
  // 生产随机源必须返回请求长度且每次独立（退化成常量会直接破坏标识唯一性）。
  test("cryptoRandomSource 满足长度、独立性与单次配额", () => {
    expect(cryptoRandomSource.bytes(0).length).toBe(0);
    const first = cryptoRandomSource.bytes(16);
    const second = cryptoRandomSource.bytes(16);
    expect(first.length).toBe(16);
    expect(Array.from(first)).not.toEqual(Array.from(second));
    expect(() => cryptoRandomSource.bytes(-1)).toThrow(RangeError);
    expect(() => cryptoRandomSource.bytes(65537)).toThrow(RangeError);
  });

  // 摘要决定 canonical 字节的比对结果，必须是 64 字符小写十六进制并与已知向量一致。
  test("sha256Digest 匹配已知向量", () => {
    const encoder = new TextEncoder();
    expect(sha256Digest(encoder.encode(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Digest(encoder.encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Digest(encoder.encode("abc"))).toMatch(/^[0-9a-f]{64}$/);
  });

  // 确定性随机源必须按 seed 复现同一字节流（含跨 32 字节块），并对非法长度立即失败而非补齐截断。
  test("deterministicRandomSource 可复现且拒绝非法长度", () => {
    const first = deterministicRandomSource("repro").bytes(48);
    const second = deterministicRandomSource("repro").bytes(48);
    const other = deterministicRandomSource("other").bytes(48);
    expect(Array.from(first)).toEqual(Array.from(second));
    expect(Array.from(first)).not.toEqual(Array.from(other));
    expect(deterministicRandomSource("len").bytes(17).length).toBe(17);
    expect(() => deterministicRandomSource("bad").bytes(-1)).toThrow(RangeError);
    expect(() => deterministicRandomSource("bad").bytes(1.5)).toThrow(RangeError);
  });
});
