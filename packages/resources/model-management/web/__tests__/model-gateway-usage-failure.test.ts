// 用量页失败分支的判定规则（`web/lib/model-gateway-usage.ts` 的 `classifyUsageFailure`）。
//
// 这条规则决定页面给不给重试入口：401/403 被 request 层归一为 `UNAUTHORIZED`，对当前用户是终态；
// 其余失败（网络、5xx、解析）都可能自愈。用例钉住这条分界，避免以后有人「顺手统一成一种错误提示」，
// 让被拒的用户对着必然失败的重试按钮反复点击。

import { describe, expect, test } from "bun:test";
import { ApiError } from "@fenix/web-runtime/api/request";
import { classifyUsageFailure } from "../lib/model-gateway-usage";

describe("classifyUsageFailure", () => {
  // 没有错误时不做任何分支：页面走正常渲染路径。
  test("无错误时返回 null", () => {
    expect(classifyUsageFailure(undefined)).toBeNull();
    expect(classifyUsageFailure(null)).toBeNull();
  });

  // 401/403 归一为 UNAUTHORIZED：属于无权限终态，页面只给原因、不给重试。
  test("UNAUTHORIZED 归为 forbidden", () => {
    expect(classifyUsageFailure(new ApiError("无权限", "UNAUTHORIZED"))).toBe("forbidden");
  });

  // 其它错误码（网络、服务端、校验）都可能自愈：归为可重试的 error。
  test("其它错误码归为可重试的 error", () => {
    expect(classifyUsageFailure(new ApiError("网关错误", "MODEL_GATEWAY_ERROR"))).toBe("error");
    expect(classifyUsageFailure(new ApiError("请求失败"))).toBe("error");
  });

  // 非 ApiError 的意外异常同样给出重试入口，而不是被当成无权限静默吞掉。
  test("非 ApiError 异常归为 error", () => {
    expect(classifyUsageFailure(new TypeError("boom"))).toBe("error");
  });
});
