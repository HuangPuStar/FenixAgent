import { Claude, DeepSeek, Gemini, Grok, type IconType, Kimi, Meta, Mistral, OpenAI, Qwen } from "@lobehub/icons";

/**
 * 单条模型→图标映射。
 * - `patterns`: 匹配模型 ID 的正则数组（大小写不敏感，对完整 modelId 做搜索）
 * - `Icon`: 渲染的主图标组件（单色品牌图标，作为默认 fallback）
 * - `Color`: 彩色变体（若存在），优先用于 `variant="color"`
 * - `label`: 注释用途，便于维护者识别归属
 */
export interface ModelIconEntry {
  patterns: RegExp[];
  Icon: IconType;
  /** 彩色变体（若存在） */
  Color?: IconType;
  label: string;
}

/**
 * 模型名称 → 图标对照表（仅收录常用主流模型）。
 *
 * - 所有 React 图标组件均来自本地安装的 `@lobehub/icons`，不使用 CDN 资源
 * - 匹配顺序：自上而下，首个命中即返回
 * - 未命中时由 `ModelIcon.tsx` 兜底到 `@lobehub/icons` 内置 `ModelIcon` helper
 *   （该 helper 内置 400+ 关键字匹配，覆盖面广，无需在此重复维护）
 *
 * 维护指引：
 *   1. 仅收录「需要本地显式映射」或「内置 helper 匹配不准」的常用模型
 *   2. 新增模型时先确认 `@lobehub/icons` 是否已有对应品牌组件
 *   3. patterns 写成最具体的前缀（如 `^claude-opus` 优先于 `^claude-`）
 */
export const modelIconMap: ModelIconEntry[] = [
  // ─── OpenAI ─────────────────────────────────────────────────────────
  {
    label: "OpenAI GPT / o-series",
    patterns: [/^gpt-/, /^o\d/, /^chatgpt/],
    Icon: OpenAI,
  },

  // ─── Anthropic Claude ───────────────────────────────────────────────
  {
    label: "Anthropic Claude",
    patterns: [/^claude-/],
    Icon: Claude,
    Color: Claude.Color,
  },

  // ─── Google Gemini ──────────────────────────────────────────────────
  {
    label: "Google Gemini",
    patterns: [/^gemini-/],
    Icon: Gemini,
    Color: Gemini.Color,
  },

  // ─── DeepSeek ───────────────────────────────────────────────────────
  {
    label: "DeepSeek",
    patterns: [/^deepseek-/],
    Icon: DeepSeek,
    Color: DeepSeek.Color,
  },

  // ─── 阿里通义千问 / Qwen ────────────────────────────────────────────
  {
    label: "Qwen / 通义千问",
    patterns: [/^qwen/, /^qwq/, /^qvq/],
    Icon: Qwen,
    Color: Qwen.Color,
  },

  // ─── 月之暗面 Kimi ──────────────────────────────────────────────────
  {
    label: "Moonshot Kimi",
    patterns: [/^moonshot-/, /^kimi-/],
    Icon: Kimi,
  },

  // ─── Meta Llama（@lobehub/icons 未单独导出 Llama，用 Meta 品牌图标） ───
  {
    label: "Meta Llama",
    patterns: [/^llama-/, /^llama\d/],
    Icon: Meta,
    Color: Meta.Color,
  },

  // ─── Mistral ────────────────────────────────────────────────────────
  {
    label: "Mistral / Mixtral",
    patterns: [/^mistral-/, /^mixtral/, /^codestral/],
    Icon: Mistral,
    Color: Mistral.Color,
  },

  // ─── xAI Grok ───────────────────────────────────────────────────────
  {
    label: "xAI Grok",
    patterns: [/^grok-/],
    Icon: Grok,
  },
];

/**
 * 在对照表中查找匹配的图标条目。
 *
 * 匹配规则：
 *   - 对 modelId 转小写后逐条遍历 `modelIconMap`
 *   - patterns 中任一正则命中即视为匹配
 *   - 自上而下首次命中即返回，保证具体规则优先
 *
 * @param modelId 完整模型 ID，如 `gpt-4o-mini` / `claude-3-opus-20240229`
 * @returns 匹配到的条目；未匹配返回 `null`，由调用方决定兜底策略
 */
export function findModelIconEntry(modelId: string | null | undefined): ModelIconEntry | null {
  if (!modelId) return null;
  const lower = modelId.toLowerCase();
  for (const entry of modelIconMap) {
    if (entry.patterns.some((re) => re.test(lower))) return entry;
  }
  return null;
}
