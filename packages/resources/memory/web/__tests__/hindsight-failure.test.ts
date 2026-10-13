// web/__tests__/hindsight-failure.test.ts
// 钉住「无权限」分支的判定口径：403/401 必须与通用加载失败分开，否则界面会给出对 403 永远无效的
// Retry 入口（见 pages/hindsight/failure.ts 的说明）。

import { describe, expect, test } from "bun:test";
import { ApiError } from "@fenix/web-runtime/api/request";
import { isForbiddenFailure, toHindsightFailure } from "../pages/hindsight/failure";

describe("Hindsight 请求失败分类", () => {
  // 本包后端在 bank 映射缺失时返回 403 { code: "forbidden" }，必须归为无权限而不是通用失败。
  test("403 且 code 为 forbidden 判为无权限", () => {
    const error = new ApiError("Cannot resolve bank ID", "forbidden");

    expect(isForbiddenFailure(error)).toBe(true);
    expect(toHindsightFailure(error)).toEqual({ kind: "forbidden" });
  });

  // request 层只在响应没有 code 时才按状态码归一，因此 403 无 code 时码值是 UNAUTHORIZED，同样要认。
  test("request 层归一的 UNAUTHORIZED 也判为无权限", () => {
    expect(toHindsightFailure(new ApiError("请求失败 (403)", "UNAUTHORIZED"))).toEqual({ kind: "forbidden" });
  });

  // 上游不可达是真实故障，必须保留诊断文案并允许重试，不能被误判成无权限而丢掉重试入口。
  test("上游不可达保留诊断文案且不属于无权限", () => {
    const failure = toHindsightFailure(new ApiError("Hindsight service unavailable", "service_unavailable"));

    expect(failure).toEqual({ kind: "error", detail: "Hindsight service unavailable" });
  });

  // 非 Error 的拒绝值（第三方库或字符串抛错）没有 message，回退到调用方给的兜底文案，避免详情为空。
  test("非 Error 值回退到兜底文案", () => {
    expect(toHindsightFailure("boom", "加载记忆失败")).toEqual({ kind: "error", detail: "加载记忆失败" });
  });
});
