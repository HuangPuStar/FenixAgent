// apps/web/src/__tests__/sync-close-diagnostic.test.ts
// 客户端关闭诊断：错误卡必须保留服务端原始 reason，并标注 wasClean/local。

import { describe, expect, test } from "bun:test";
import { formatSyncCloseError } from "../../../../packages/agent-runtime/web/yjs/sync-close-diagnostic";

describe("sync close diagnostic", () => {
  // 服务端 1008 的 reason 原样进入错误消息，并带 wasClean=false/local=false。
  test("保留服务端 reason 与关闭标记", () => {
    const error = formatSyncCloseError({
      code: "WS_1008",
      reason: "sync protocol unavailable",
      wasClean: false,
      local: false,
    });
    expect(error.code).toBe("WS_1008");
    expect(error.message).toBe("sync protocol unavailable [wasClean=false, local=false]");
  });

  // 空 reason 用 code 占位，避免错误卡只有标记没有原因。
  test("空 reason 回退到关闭码", () => {
    const error = formatSyncCloseError({ code: "WS_1008", reason: "", wasClean: true, local: true });
    expect(error.message).toBe("WS_1008 [wasClean=true, local=true]");
  });
});
