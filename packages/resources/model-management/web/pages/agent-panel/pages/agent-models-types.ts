import type { ProviderInfo, ProviderModel } from "@fenix/web-runtime/types/config";

export interface ProviderCatalogData {
  providers: ProviderInfo[];
  modelsByProvider: Record<string, ProviderModel[]>;
  detailFailures: string[];
}

/**
 * Provider 文本字段（显示名 / Base URL）在本次编辑中的状态。
 *
 * 与 {@link ModelThinkingDraft} 同一设计语言：`edited` 区分「用户触碰过输入框」与「仅用于回显」。后端对
 * 缺省键的语义是"不修改"（`provider-handlers.ts` 的 `!== undefined` 判断），因此只有触碰过的字段才提交：
 * 触碰后为空提交显式 `null`（清空），非空提交新值。库中本来就没有显示名 / Base URL 时输入框同样是空的，
 * 用独立的标签位表达「未触碰」才不会把"回显为空"误判成"用户清空"。
 */
export type ProviderTextFieldDraft = { edited: false; value: string } | { edited: true; value: string };

export interface ProviderDraft {
  id: string;
  displayName: ProviderTextFieldDraft;
  protocol: "openai" | "anthropic";
  /**
   * API Key 刻意保持裸字符串：详情只回 `keyHint` 掩码、不回原文，输入框恒空且 placeholder 是「留空表示
   * 不修改」，所以「空」在这里只表示"不提交该键"，与显示名 / Base URL 的"空 = 清空"是两种语义。
   */
  apiKey: string;
  baseURL: ProviderTextFieldDraft;
  selectedModels: string[];
}

/**
 * 思考开关在本次编辑中的状态。
 *
 * `edited` 区分「用户触碰过开关」与「仅用于回显」：`options` 是整列写入的自由形状 jsonb，只有触碰过
 * 才允许提交 `thinking` 子键，否则会把该列里用户没编辑过的其它键（temperature / streaming 等）一并
 * 抹掉。用独立的标签位而不是哨兵值表达「未改动」，让判断点无法与「值恰好是 false」混淆。
 */
export type ModelThinkingDraft = { edited: false; enabled: boolean } | { edited: true; enabled: boolean };

/**
 * 上下文 / 输出上限在本次编辑中的状态。
 *
 * 与 {@link ModelThinkingDraft} 同一设计语言：`limit_config` 同样是整列写入的自由形状 jsonb，表单只认识
 * `context` / `output` 两个键（`rpm` 等由消费方约定），所以只有用户触碰过任一数字框才允许提交该列，并且
 * 提交时必须合并原有键。`edited` 与「值恰好是空串」无关：用户清空输入框是"这个键不再有配置"，回显为空
 * 则什么都没表示。
 */
export type ModelLimitDraft =
  | { edited: false; context: string; output: string }
  | { edited: true; context: string; output: string };

export interface ModelDraft {
  id: string;
  name: string;
  limit: ModelLimitDraft;
  inputModalities: string[];
  outputModalities: string[];
  thinking: ModelThinkingDraft;
}

export type ProviderDialogTarget = { mode: "create" } | { mode: "edit" | "view"; provider: ProviderInfo };

export type ModelDialogTarget =
  | { mode: "create"; providerKey: string }
  | { mode: "edit" | "view"; providerKey: string; model: ProviderModel };

export interface DiscoveryState {
  providerKey: string;
  models: string[];
  addedIds: Set<string>;
  warning?: string;
}

export interface ModelTestState {
  key: string;
  status: "running" | "success" | "error";
  detail?: string;
}
