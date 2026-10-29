// 消息通道页面的纯逻辑契约。
//
// 这里的判据同时决定「渲染哪一种状态」与「能不能提交」：状态判定错会把「没权限」显示成「没有通道」，
// 配置校验错会让一次必然失败的创建请求打到后端。页面组件在 happy-dom 下的用例只覆盖渲染接线，
// 边界值集中在本文件。

import { describe, expect, test } from "bun:test";
import type { LangBotBot, LangBotRoute } from "@fenix/resource-channel/web";
import {
  formatDateTime,
  groupRoutesByChannel,
  isUnauthorizedError,
  parseBotConfigJson,
  resolveChannelListViewState,
} from "@fenix/resource-channel/web/lib/channel-page-state";
import { ApiError } from "@fenix/web-runtime/api/request";

function bot(overrides: Partial<LangBotBot> = {}): LangBotBot {
  return {
    botUuid: "bot-1",
    name: "客服机器人",
    adapter: "feishu",
    channelId: "channel-1",
    channelName: "客服通道",
    status: "connected",
    boundRouteCount: 0,
    missingInLangbot: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function route(overrides: Partial<LangBotRoute> = {}): LangBotRoute {
  return {
    id: "route-1",
    channelId: "channel-1",
    chatType: "group",
    chatId: "chat-1",
    agentConfigId: "agent-1",
    enabled: true,
    instances: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("列表状态判定", () => {
  // 业务意图：首屏无数据且请求进行中时只能显示骨架；先渲染空态会让用户以为通道被删光了。
  test("首屏请求进行中 → loading", () => {
    expect(resolveChannelListViewState({ loading: true, error: null, itemCount: 0 })).toBe("loading");
  });

  // 业务意图：401/403 是持久状态，重试没有意义，必须与普通加载失败分开呈现。
  test("无数据且错误码为 UNAUTHORIZED / FORBIDDEN → unauthorized", () => {
    for (const code of ["UNAUTHORIZED", "FORBIDDEN"]) {
      const state = resolveChannelListViewState({
        loading: false,
        error: new ApiError("无权限", code),
        itemCount: 0,
      });
      expect(state, code).toBe("unauthorized");
    }
  });

  // 业务意图：后端业务错误码（如 LANGBOT_UNREACHABLE）应落到可重试的错误态，而不是被当成无权限。
  test("无数据且是普通错误 → error", () => {
    const state = resolveChannelListViewState({
      loading: false,
      error: new ApiError("LangBot 不可达", "LANGBOT_UNREACHABLE"),
      itemCount: 0,
    });
    expect(state).toBe("error");
  });

  // 业务意图：请求成功但确实没有数据才是空态，空态要引导创建而不是给重试。
  test("请求成功且没有数据 → empty", () => {
    expect(resolveChannelListViewState({ loading: false, error: null, itemCount: 0 })).toBe("empty");
  });

  // 业务意图：已有数据时的刷新失败保留旧数据，不能把用户正在看的表格替换成错误块。
  test("已有数据时刷新失败 → 仍是 ready", () => {
    const state = resolveChannelListViewState({
      loading: false,
      error: new ApiError("刷新失败", "SERVER_ERROR"),
      itemCount: 2,
    });
    expect(state).toBe("ready");
  });
});

describe("无权限判定", () => {
  // 业务意图：`request()` 把 403 归一为 UNAUTHORIZED，但控制面会透传 FORBIDDEN，两者都必须识别。
  test("识别 UNAUTHORIZED 与 FORBIDDEN，忽略其它错误码与非法输入", () => {
    expect(isUnauthorizedError(new ApiError("a", "UNAUTHORIZED"))).toBe(true);
    expect(isUnauthorizedError(new ApiError("b", "FORBIDDEN"))).toBe(true);
    expect(isUnauthorizedError(new ApiError("c", "SERVER_ERROR"))).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
    expect(isUnauthorizedError("UNAUTHORIZED")).toBe(false);
  });
});

describe("Bot 配置 JSON 校验", () => {
  // 业务意图：空文本的语义由调用方决定（创建 = 空对象，编辑 = 保持不变），解析层不把空当成错误。
  test("空文本 → 空对象", () => {
    expect(parseBotConfigJson("   ")).toEqual({ ok: true, value: {} });
  });

  // 业务意图：合法对象是唯一允许提交的形态。
  test("合法对象 → 原样返回", () => {
    expect(parseBotConfigJson('{"token":"x"}')).toEqual({ ok: true, value: { token: "x" } });
  });

  // 业务意图：语法错误必须在本地拦下，避免一次必然 422 的往返。
  test("非法 JSON → syntax", () => {
    expect(parseBotConfigJson("{token:x}")).toEqual({ ok: false, reason: "syntax" });
  });

  // 业务意图：数组与标量不是「适配器配置对象」，后端会拒绝，前端给出针对性文案。
  test("数组或标量 → notObject", () => {
    expect(parseBotConfigJson("[1,2]")).toEqual({ ok: false, reason: "notObject" });
    expect(parseBotConfigJson("42")).toEqual({ ok: false, reason: "notObject" });
    expect(parseBotConfigJson("null")).toEqual({ ok: false, reason: "notObject" });
  });

  // 业务意图：64 KiB 上限与后端 schema 一致，超限在本地拦截。
  test("超过 64 KiB → tooLarge", () => {
    expect(parseBotConfigJson(JSON.stringify({ blob: "x".repeat(70_000) }))).toEqual({
      ok: false,
      reason: "tooLarge",
    });
  });
});

describe("路由分组", () => {
  // 业务意图：分组顺序跟随 Bot 列表，刷新后不会因为路由多寡而跳动。
  test("按 Bot 顺序分组，并追加只在路由里出现的通道", () => {
    const bots = [bot({ channelId: "channel-2", channelName: "二号通道" }), bot()];
    const routes = [
      route({ id: "r-3", channelId: "channel-9" }),
      route({ id: "r-1" }),
      route({ id: "r-2", channelId: "channel-2" }),
    ];

    const groups = groupRoutesByChannel(routes, bots);

    expect(groups.map((group) => group.channelId)).toEqual(["channel-2", "channel-1", "channel-9"]);
    expect(groups.map((group) => group.channelName)).toEqual(["二号通道", "客服通道", "channel-9"]);
    expect(groups.map((group) => group.routes.map((item) => item.id))).toEqual([["r-2"], ["r-1"], ["r-3"]]);
  });

  // 业务意图：LangBot 侧删掉 Bot 后，平台上的路由仍然可见，并标出通道已缺失。
  test("Bot 在 LangBot 中缺失时保留分组并标记", () => {
    const bots = [bot({ missingInLangbot: true })];
    const groups = groupRoutesByChannel([route()], bots);
    expect(groups[0]?.missingBot).toBe(true);
  });
});

describe("时间展示", () => {
  // 业务意图：空值交给调用方配「从未」文案；非法值原样回退，便于发现后端契约漂移。
  test("空值返回 null，非法值原样返回", () => {
    expect(formatDateTime(null, "zh-CN")).toBeNull();
    expect(formatDateTime("not-a-date", "zh-CN")).toBe("not-a-date");
    expect(formatDateTime("2026-10-01T00:00:00.000Z", "zh-CN")).not.toBeNull();
  });
});
