import type { TFunction } from "i18next";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { ToolCallData } from "@/src/lib/types";

/**
 * 工具调用的状态枚举。映射自 ACP 协议 ToolCallUpdate.status。
 * - running: 正在执行
 * - complete: 成功完成
 * - error: 失败
 * - waiting_for_confirmation: 等待用户授权
 * - rejected: 用户拒绝授权（归一化为 canceled 处理）
 * - canceled: 被取消
 *
 * 注意：ToolCallData.status 包含 rejected，但 narrator 统一把
 * rejected 当 canceled 处理（视觉上都是"已取消"）。
 */
export type ToolStatus = "running" | "complete" | "error" | "waiting_for_confirmation" | "rejected" | "canceled";

/**
 * Narration 上下文。传递给每个 narrator 的方法。
 * - tool: 完整的工具调用数据
 * - status: 已归一化的状态（rejected 已映射为 canceled）
 * - elapsedMs: 前端计算的耗时（complete/error 状态下用于徽章）
 * - t: i18n 翻译函数（由 ToolCallRow 通过 useTranslation 拿到后传入）
 */
export interface NarrationContext {
  tool: ToolCallData;
  status: Exclude<ToolStatus, "rejected">;
  elapsedMs?: number;
  t: TFunction;
}

export type BadgeTone = "info" | "warn" | "error" | "success";

export interface NarrationBadge {
  tone: BadgeTone;
  text: string;
}

/**
 * 卡片展示用的双字段：title 是第一行（文件名/命令/URL），
 * object 是副标题里的"对象"部分（与 verb 拼成副标题）。
 */
export interface ToolDisplay {
  title: ReactNode;
  object: ReactNode;
}

/**
 * Narration 结果。中央 narrate() 返回，ToolCallRow 直接渲染。
 */
export interface NarrationResult {
  icon?: LucideIcon;
  title: ReactNode;
  subtitle: ReactNode;
  statusLabel: string;
  badge?: NarrationBadge;
  errorDetail?: string;
  detail: {
    rawInput?: unknown;
    rawOutput?: unknown;
  };
}

/**
 * 工具 narrator 接口。每个工具实现一份。
 *
 * 设计要点：
 * - match: 工具名匹配（已转小写），注册表按顺序匹配
 * - verb: 中文动词
 * - icon: 卡片图标
 * - getDisplay: 同时返回 title 和 object，narrator 完全自包含
 * - badge: 可选的计数徽章
 *
 * 副标题拼接完全在中央 narrate() 完成（用 common.subtitle / subtitleRunning 模板），
 * narrator 不参与文案拼接，保证格式一致。
 */
export interface ToolNarrator {
  match: (toolNameLower: string) => boolean;
  verb: string;
  icon: LucideIcon;
  getDisplay: (ctx: NarrationContext) => ToolDisplay;
  badge?: (ctx: NarrationContext) => NarrationBadge | undefined;
}
