import { describe, expect, test } from "bun:test";
import { createPublicError, isPublicError, PUBLIC_ERROR_MESSAGES, PUBLIC_ERROR_TYPES } from "../public-error";

describe("PublicError 公开契约", () => {
  // 每个稳定 Type 都必须同时具有中英文受控安全摘要。
  test("注册表完整覆盖所有公开 Type", () => {
    expect(Object.keys(PUBLIC_ERROR_MESSAGES).sort()).toEqual([...PUBLIC_ERROR_TYPES].sort());
    for (const type of PUBLIC_ERROR_TYPES) {
      expect(PUBLIC_ERROR_MESSAGES[type].zh.length).toBeGreaterThan(0);
      expect(PUBLIC_ERROR_MESSAGES[type].en.length).toBeGreaterThan(0);
    }
  });

  // Error ID 使用 16 字节 CSPRNG，不携带业务标识且每次故障独立生成。
  test("生成至少 128 bit 的随机 Error ID", () => {
    const first = createPublicError("INTERNAL.UNCLASSIFIED");
    const second = createPublicError("INTERNAL.UNCLASSIFIED");
    expect(first.id).toMatch(/^err_[0-9a-f]{32}$/);
    expect(second.id).toMatch(/^err_[0-9a-f]{32}$/);
    expect(first.id).not.toBe(second.id);
  });

  // 边界只接受注册表摘要，任意原始 message 即使 Type/ID 合法也必须拒绝。
  test("拒绝任意 message 与旧公开契约", () => {
    const valid = createPublicError("ACTION.FAILED");
    expect(isPublicError(valid)).toBe(true);
    expect(isPublicError({ ...valid, message: "token=secret" })).toBe(false);
    expect(isPublicError({ area: "action", code: "failed", message: "failed", retryable: true })).toBe(false);
  });

  // 不可信分类输入必须保守收敛为 INTERNAL.UNCLASSIFIED，不能甩锅给业务域。
  test("未知 Type 收敛为 INTERNAL.UNCLASSIFIED", () => {
    const error = createPublicError("AGENT_UNAVAILABLE" as never);
    expect(error.type).toBe("INTERNAL.UNCLASSIFIED");
    expect(error.message).toBe(PUBLIC_ERROR_MESSAGES["INTERNAL.UNCLASSIFIED"].en);
  });
});
