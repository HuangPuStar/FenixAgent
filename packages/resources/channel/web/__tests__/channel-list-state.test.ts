// web/__tests__/channel-list-state.test.ts
// 守护通道绑定列表的分支判定规则（任务 1.3 §1.3(6)：失败必须有持久错误分支、不得退化成空态）。
//
// 为什么测纯函数而不是渲染页面：这三条规则正是「状态 + 数据流」而不是 UI 结构——
// 用渲染断言反而会把测试钉在 JSX 形状上。渲染分支与这里的判定一一对应（AgentChannelsPage 按同一个
// `resolveChannelListState` 的返回值分流），规则回归会同时被本文件与页面的分支入口暴露。

import { describe, expect, test } from "bun:test";
import { ApiError } from "@fenix/web-runtime/api/request";
import { resolveChannelListState } from "../lib/channel-list-state";

describe("通道绑定列表分支判定", () => {
  // 刷新期间 loading 与上一轮 error 会短暂同时为真，此时必须按加载态渲染，否则会先闪一次旧错误。
  test("加载中优先于上一轮的失败", () => {
    expect(resolveChannelListState({ loading: true, error: new Error("上一轮失败"), itemCount: 0 })).toBe("loading");
  });

  // 首次加载失败且尚无数据：必须是持久错误态，不能落回 AgentCardList 的「暂无绑定」空态。
  test("首次加载失败且无数据时进入持久错误分支", () => {
    expect(resolveChannelListState({ loading: false, error: new ApiError("boom", "SERVER_ERROR"), itemCount: 0 })).toBe(
      "error",
    );
  });

  // request 层把 401（未认证）与 403（无权限）都归一为 UNAUTHORIZED，页面据此走无权限分支且不给重试按钮。
  test("鉴权失败（401/403 归一）单独判为无权限分支", () => {
    expect(
      resolveChannelListState({ loading: false, error: new ApiError("forbidden", "UNAUTHORIZED"), itemCount: 0 }),
    ).toBe("unauthorized");
  });

  // 非 ApiError（网络层异常、拦截器抛错等）没有错误码，一律按一般失败处理，不能误判成无权限。
  test("无错误码的失败按一般错误处理", () => {
    expect(resolveChannelListState({ loading: false, error: "network down", itemCount: 0 })).toBe("error");
  });

  // 已有数据后刷新失败：保留已渲染的列表，清空会让一次刷新失败抹掉用户正在看的绑定。
  test("已有数据后刷新失败仍保持列表可用", () => {
    expect(resolveChannelListState({ loading: false, error: new ApiError("boom", "SERVER_ERROR"), itemCount: 3 })).toBe(
      "ready",
    );
  });

  // 正常路径的三个取值都要能到达 ready，否则页面会永远停在骨架屏或错误态。
  test("无失败时进入就绪分支（含空列表）", () => {
    expect(resolveChannelListState({ loading: false, error: undefined, itemCount: 0 })).toBe("ready");
    expect(resolveChannelListState({ loading: false, error: null, itemCount: 2 })).toBe("ready");
  });
});
