import { describe, expect, test } from "bun:test";
import { PUBLIC_ERROR_TYPES } from "../public-error";
import {
  asSyncProtocolError,
  isRetryableSyncErrorCode,
  SYNC_ERROR_CODES,
  type SyncErrorCode,
  SyncProtocolError,
} from "../sync/protocol/errors";
import { assertIdentifier } from "../sync/protocol/identity";

/** 捕获本层协议错误；非本层异常原样抛出以免掩盖真实缺陷。 */
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

describe("同步错误码表", () => {
  // 错误码是对端与日志的稳定判定依据：必须唯一、非空、符合 UPPER_SNAKE_CASE，数量变化需显式确认。
  test("码表唯一、格式规范且数量稳定", () => {
    expect(SYNC_ERROR_CODES.length).toBe(27);
    expect(new Set(SYNC_ERROR_CODES).size).toBe(SYNC_ERROR_CODES.length);
    for (const code of SYNC_ERROR_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  // 可重试判定必须逐码穷举且与声明集合一致，本用例是「漏写分支落到默认值」的回归防线。
  test("可重试集合逐码穷举且不重不漏", () => {
    const retryable: SyncErrorCode[] = [
      "COMMIT_OUTCOME_UNKNOWN",
      "SCOPE_BUSY",
      "CAPACITY_EXCEEDED",
      "ADMISSION_REJECTED",
      "STAGING_FAILED",
      "BINDING_UNKNOWN",
    ];
    const nonRetryable = SYNC_ERROR_CODES.filter((code) => !retryable.includes(code));
    expect(SYNC_ERROR_CODES.filter(isRetryableSyncErrorCode)).toEqual(retryable);
    expect([...retryable, ...nonRetryable].sort()).toEqual([...SYNC_ERROR_CODES].sort());
    for (const code of SYNC_ERROR_CODES) {
      expect(typeof isRetryableSyncErrorCode(code)).toBe("boolean");
      expect(isRetryableSyncErrorCode(code)).toBe(retryable.includes(code));
    }
  });

  // 协议内部码与公开错误注册表是两层契约：任何内部码出现在公开注册表都等于把实现细节变成对外承诺。
  test("协议内部码不得出现在公开错误注册表", () => {
    const publicTypes: readonly string[] = PUBLIC_ERROR_TYPES;
    for (const code of SYNC_ERROR_CODES) {
      expect(publicTypes).not.toContain(code);
    }
  });
});

describe("SyncProtocolError", () => {
  // 构造时按码推导 retryable，显式覆盖优先；码表内每个码都必须能构造出错误对象。
  test("按码推导 retryable 并允许显式覆盖", () => {
    expect(new SyncProtocolError("SCOPE_BUSY").retryable).toBe(true);
    expect(new SyncProtocolError("MALFORMED_FRAME").retryable).toBe(false);
    expect(new SyncProtocolError("MALFORMED_FRAME", { retryable: true }).retryable).toBe(true);
    expect(new SyncProtocolError("SCOPE_BUSY", { retryable: false }).retryable).toBe(false);

    for (const code of SYNC_ERROR_CODES) {
      const error = new SyncProtocolError(code);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("SyncProtocolError");
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(isRetryableSyncErrorCode(code));
      expect(error.toFrameContext()).toEqual({});
    }
  });

  // safeContext 是安全出口：只允许定位字段，toFrameContext 必须返回副本以免污染错误对象本身。
  test("safeContext 只含定位字段且 toFrameContext 返回副本", () => {
    const error = new SyncProtocolError("MALFORMED_FRAME", {
      safeContext: { scope: "org-1/rcs_abc", docId: "sync/content/gen_1/0/n1", seq: 7 },
    });
    const expected = { scope: "org-1/rcs_abc", docId: "sync/content/gen_1/0/n1", seq: 7 };
    expect(error.toFrameContext()).toEqual(expected);

    const frameContext = error.toFrameContext();
    frameContext.seq = 8;
    expect(error.safeContext.seq).toBe(7);
  });

  // 诊断上下文只能经 cause 保留：原始异常文本（可能含正文或凭据）不得进入 message 与安全上下文。
  test("cause 保留诊断上下文而不泄露原始文本", () => {
    const cause = new Error("upstream failed: token=SECRET-BODY");
    const error = new SyncProtocolError("MALFORMED_FRAME", { cause });
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain("SECRET-BODY");
    expect(JSON.stringify(error.toFrameContext())).not.toContain("SECRET-BODY");
  });

  // 真实触发点产生的错误同样不得回显触发值：超长标识常来自不可信输入或鉴权上下文。
  test("触发点抛出的错误不回显触发值", () => {
    const secret = `token=SECRET-BODY-${"x".repeat(300)}`;
    const error = captureSyncError(() => assertIdentifier(secret, "docId.nonce"));
    expect(error.code).toBe("IDENTIFIER_TOO_LONG");
    expect(error.message).not.toContain("SECRET-BODY");
    expect(JSON.stringify(error.safeContext)).not.toContain("SECRET-BODY");
    expect(error.toFrameContext()).toEqual({});
  });
});

describe("asSyncProtocolError", () => {
  // 同层错误必须原样返回（保留 code、retryable 与 safeContext），避免二次包装丢失判定信息。
  test("同层错误原样返回", () => {
    const original = new SyncProtocolError("SCOPE_BUSY", { safeContext: { scope: "org-1/rcs_abc" } });
    expect(asSyncProtocolError(original, "MALFORMED_FRAME")).toBe(original);
  });

  // 未知异常按 fallbackCode 包装并挂到 cause，且不复制原始 message（可能含正文或凭据）。
  test("未知异常按 fallbackCode 包装且不复制原始 message", () => {
    const cause = new Error("failed: token=SECRET-BODY");
    const wrapped = asSyncProtocolError(cause, "STAGING_FAILED");
    expect(wrapped.code).toBe("STAGING_FAILED");
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.cause).toBe(cause);
    expect(wrapped.message).toBe("sync protocol error: STAGING_FAILED");
    expect(wrapped.message).not.toContain("SECRET-BODY");

    const wrappedUnknown = asSyncProtocolError("boom", "CAPACITY_EXCEEDED");
    expect(wrappedUnknown.cause).toBe("boom");
    expect(wrappedUnknown.retryable).toBe(true);
    expect(wrappedUnknown.safeContext).toEqual({});
  });
});
