/**
 * 消息通道页面的纯逻辑：列表状态判定、Bot 配置校验、路由分组与时间格式化。
 *
 * 放在 `web/lib/` 而不是页面文件里，原因是这些判据同时决定「渲染哪一种状态」和「能不能提交」，
 * 只有独立出来才可以在没有 DOM / Radix 的用例里逐条验证（前端规范 §5.4 的域模块形态）。
 */

import type { LangBotBot, LangBotRoute } from "../api/langbot";

export type ChannelListViewState = "loading" | "unauthorized" | "error" | "empty" | "ready";

/** `request()` 把 401/403 归一为 UNAUTHORIZED，但控制面 403 会透传 FORBIDDEN，两者都必须按无权限处理。 */
export function isUnauthorizedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "UNAUTHORIZED" || code === "FORBIDDEN";
}

/**
 * 列表状态判定：已有数据时的刷新失败保留旧数据，只有「没有数据可展示」才落到整块错误/无权限态。
 * 与知识库、MCP 目录的判据一致，避免刷新失败把用户正在看的内容清空。
 */
export function resolveChannelListViewState(input: {
  readonly loading: boolean;
  readonly error: unknown;
  readonly itemCount: number;
}): ChannelListViewState {
  if (input.error && input.itemCount === 0) return isUnauthorizedError(input.error) ? "unauthorized" : "error";
  if (input.loading && input.itemCount === 0) return "loading";
  if (input.itemCount === 0) return "empty";
  return "ready";
}

/** Bot 配置的 64 KiB 上限与后端 `BotConfigSchema` 一致，前端提前拦截避免一次必然失败的往返。 */
const MAX_BOT_CONFIG_BYTES = 64 * 1024;

export type BotConfigParseResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: "syntax" | "notObject" | "tooLarge" };

/**
 * 解析适配器配置 JSON。
 *
 * 空文本按空对象处理：创建时后端要求 `config` 是对象，而编辑时调用方用「空文本」表达「保持不变」，
 * 因此「空」的语义由调用方决定，解析本身不把空文本当成错误。
 */
export function parseBotConfigJson(text: string): BotConfigParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "syntax" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "notObject" };
  }

  const size = new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
  if (size > MAX_BOT_CONFIG_BYTES) return { ok: false, reason: "tooLarge" };

  return { ok: true, value: parsed as Record<string, unknown> };
}

/** 一个通道下的路由集合；`missingBot` 表示平台有通道记录但 LangBot 列表里没有对应 Bot。 */
export interface ChannelRouteGroup {
  readonly channelId: string;
  readonly channelName: string;
  readonly missingBot: boolean;
  readonly routes: readonly LangBotRoute[];
}

/**
 * 按通道分组路由。
 *
 * 顺序先跟随 Bot 列表（LangBot 的返回顺序就是用户熟悉的顺序），再追加只在路由里出现的通道，
 * 这样刷新后分组不会因为路由多寡而跳动。
 */
export function groupRoutesByChannel(
  routes: readonly LangBotRoute[],
  bots: readonly LangBotBot[],
): ChannelRouteGroup[] {
  const names = new Map<string, { name: string; missingBot: boolean }>();
  const order: string[] = [];

  for (const bot of bots) {
    if (!bot.channelId || names.has(bot.channelId)) continue;
    names.set(bot.channelId, {
      name: bot.channelName ?? bot.name,
      missingBot: bot.missingInLangbot,
    });
    order.push(bot.channelId);
  }

  const grouped = new Map<string, LangBotRoute[]>();
  for (const route of routes) {
    const bucket = grouped.get(route.channelId);
    if (bucket) bucket.push(route);
    else grouped.set(route.channelId, [route]);
  }

  const result: ChannelRouteGroup[] = [];
  for (const channelId of order) {
    const known = names.get(channelId);
    result.push({
      channelId,
      channelName: known?.name ?? channelId,
      missingBot: known?.missingBot ?? false,
      routes: grouped.get(channelId) ?? [],
    });
    grouped.delete(channelId);
  }

  for (const [channelId, channelRoutes] of grouped) {
    result.push({ channelId, channelName: channelId, missingBot: false, routes: channelRoutes });
  }

  return result;
}

/** 时间戳展示；空值由调用方配「从未」文案，非法值原样回退以便定位后端契约漂移。 */
export function formatDateTime(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(date);
}
