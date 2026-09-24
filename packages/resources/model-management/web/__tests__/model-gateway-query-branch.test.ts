// web/__tests__/model-gateway-query-branch.test.ts
// 管理页「手动查询」分支判定的用例：钉住 §3.4 的「失败不得映射成 empty」在**判定层**成立——
// 用量与预算两个 Tab 的请求失败时，派生出的分支必须是 `failure`，不能落回 `idle`（「请先查询」提示）
// 或 `ready`（拿上一轮的旧数据当这次查询的结果）。
//
// 为什么在纯函数上断言而不渲染面板：两个面板收的是整个 controller 对象（`useModelGatewayUsage` /
// `useModelGatewayBudgets` 的返回值，含十几个状态与三个请求），渲染级用例要先造一份同样宽度的替身，
// 而被钉住的规则本身与 DOM 无关。渲染路径由面板里的 `queryBranch === "failure" ? <EmptyState …>` 单向消费，
// 规则正确 + 消费点是同一份判定，就不必为「分支顺序」再付一次 DOM 引导的成本
// （与 `model-gateway-usage-failure.test.ts` 对 `classifyUsageFailure` 的处理同款）。

import { describe, expect, test } from "bun:test";
import { ApiError } from "@fenix/web-runtime/api/request";
import { resolveModelGatewayQueryBranch } from "../lib/model-gateway-query";

describe("resolveModelGatewayQueryBranch", () => {
  // 进行中优先：重查期间不能先闪一次上一轮的失败态。
  test("加载中优先于失败与数据", () => {
    expect(resolveModelGatewayQueryBranch({ loading: true, error: new Error("boom"), hasData: true })).toBe("loading");
    expect(resolveModelGatewayQueryBranch({ loading: true, error: undefined, hasData: false })).toBe("loading");
  });

  // 失败即失败态：这是本轮的核心红线——失败绝不能与「还没查询过」合流。
  test("失败派生 failure 而不是 idle（未查询）", () => {
    expect(resolveModelGatewayQueryBranch({ loading: false, error: new ApiError("网关错误"), hasData: false })).toBe(
      "failure",
    );
  });

  // 重查失败时 ahooks 会保留上一轮的 data：此时仍须是失败态，不能让旧数字冒充这次查询的结果。
  test("已有旧数据时失败仍派生 failure，不冒充 ready", () => {
    expect(resolveModelGatewayQueryBranch({ loading: false, error: new Error("boom"), hasData: true })).toBe("failure");
  });

  // 非 ApiError 的意外异常（网络层、解析）同样给失败态，不能被当成「没有数据」静默吞掉。
  test("非 ApiError 异常同样派生 failure", () => {
    expect(resolveModelGatewayQueryBranch({ loading: false, error: "string-error", hasData: false })).toBe("failure");
  });

  // 真的没有查过（无数据也无错误）才是 idle：这是唯一允许显示「请先查询」的输入。
  test("无数据无错误派生 idle", () => {
    expect(resolveModelGatewayQueryBranch({ loading: false, error: undefined, hasData: false })).toBe("idle");
    expect(resolveModelGatewayQueryBranch({ loading: false, error: null, hasData: false })).toBe("idle");
  });

  // 有数据且无错误：正常渲染结果区。
  test("有数据且无错误派生 ready", () => {
    expect(resolveModelGatewayQueryBranch({ loading: false, error: undefined, hasData: true })).toBe("ready");
  });
});
