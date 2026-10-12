/**
 * Chat 载荷的识别与归一化。
 *
 * 移植来源：langfuse-lite `packages/web/src/shared/components/chat-utils.ts`（同一作者的产品）。
 *
 * 上游把对话写在 observation 的 input/output 里，有两族形状，必须收敛到同一套判定与分片模型：
 * - OpenAI 系：字符串 `content` + 消息级 `tool_calls[]`；
 * - Anthropic 系：`content` 分片数组（text / thinking / tool_use / tool_result / image / audio）。
 * 判定放在这里而不是各组件里：chat 视图与 JSON 视图要不要分支、预览摘要怎么取文本、测试怎么断言，
 * 都依赖同一判据；分成两份后，「带 tool_calls 但没有 content」这类边界会得出两种结论。
 *
 * 本次适配：只改 import 路径（`@/shared/lib/format` → 起初是本包 `./format`，2026-10-10 随 `truncate` 下沉
 * 改指 `@fenix/ui-components/lib/format`），判定与分片语义原样保留。
 * 括号占位符（`[image]` / `[audio]` / `[thinking]`）由纯解析层产出，是结构化标记而非界面文案，保持英文原样
 * （预览摘要与测试把它当协议标记使用）；界面文案一律由组件层 `t()` 提供。
 */
import { truncate } from "@fenix/ui-components/lib/format";

/** 协议里的已知角色；其它角色按原样渲染，不丢弃。 */
export type ChatRole = "system" | "user" | "assistant" | "tool" | "function" | "developer";

export type ChatMessage = {
  role: string;
  content: unknown;
  name?: string;
  toolCalls?: unknown;
  toolCallId?: string;
  /**
   * 原始消息对象，无损保留。
   *
   * 解析层不加工形状，只做归一化视图：界面需要回看协议原文时（调试、后续加 JSON 分支）不必重新解析，
   * 测试也据此断言「归一化没有丢字段」。
   */
  raw: unknown;
};

const KNOWN_ROLES = new Set(["system", "user", "assistant", "tool", "function", "developer"]);

function isMessageLike(item: unknown): item is ChatMessage {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
  const obj = item as Record<string, unknown>;
  if (typeof obj.role !== "string") return false;
  // 消息可以没有 `content`：OpenAI 允许只带 tool_calls 的 assistant 轮次，Anthropic 的工具结果用
  // `content` 分片数组承载；因此「role 已知」与「有 content / tool_calls」都算消息特征。
  return "content" in obj || "tool_calls" in obj || "toolCalls" in obj || KNOWN_ROLES.has(obj.role);
}

/**
 * 判断 `data` 是否形如 chat 载荷：
 * - `{ messages: [...] }`（trace input 最常见形状）
 * - 裸的消息对象数组
 */
export function isChatPayload(data: unknown): boolean {
  if (Array.isArray(data)) {
    return data.length > 0 && data.every(isMessageLike);
  }
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    const msgs = obj.messages;
    return Array.isArray(msgs) && msgs.length > 0 && msgs.every(isMessageLike);
  }
  return false;
}

/** 从 chat 载荷里取出消息数组；不是已知 chat 形状时返回 null（调用方据此回退 JSON 视图）。 */
export function extractMessages(data: unknown): ChatMessage[] | null {
  if (!isChatPayload(data)) return null;
  const raw = Array.isArray(data) ? data : (data as Record<string, unknown>).messages;
  return (raw as Record<string, unknown>[]).map((m) => ({
    role: normalizeRole(m.role, m.content),
    content: m.content,
    name: typeof m.name === "string" ? m.name : undefined,
    toolCalls: m.tool_calls ?? m.toolCalls,
    toolCallId: typeof m.tool_call_id === "string" ? m.tool_call_id : undefined,
    raw: m,
  }));
}

/**
 * Anthropic 协议细节：工具结果由 `role: "user"` 且 content 是 `{type: "tool_result"}` 分片数组的消息承载。
 * 这类消息归一化成 `tool` 角色，才能与 OpenAI 专用 `tool` 角色一样渲染成工具结果气泡，而不是用户发言。
 */
function normalizeRole(role: unknown, content: unknown): string {
  const r = typeof role === "string" ? role.toLowerCase() : "user";
  if (
    r === "user" &&
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((p) => typeof p === "object" && p !== null && (p as Record<string, unknown>).type === "tool_result")
  ) {
    return "tool";
  }
  return r;
}

/**
 * 从消息 content 里取可显示文本，content 可能是：
 * - 纯字符串
 * - 分片数组（`{type:"text", text}` / `{type:"image_url",…}` …）
 * - 任意对象（序列化）
 */
export function contentToText(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null) {
          const p = part as Record<string, unknown>;
          if (p.type === "text" && typeof p.text === "string") return p.text;
          if (p.type === "image_url") return "[image]";
          if (p.type === "input_audio") return "[audio]";
          // Anthropic 风格分片
          if (p.type === "thinking" && typeof p.thinking === "string") {
            return `[thinking]\n${p.thinking}`;
          }
          if (p.type === "tool_use") {
            const name = typeof p.name === "string" ? p.name : "tool";
            const args = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? "");
            return `[tool_use: ${name}(${truncate(args, 200)})]`;
          }
          if (p.type === "tool_result") {
            return `[tool_result]\n${contentToText(p.content)}`;
          }
          return JSON.stringify(part);
        }
        return String(part);
      })
      .join("\n");
  }
  if (typeof content === "object") {
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      // 循环引用等序列化失败：退化成 String()，保证预览层永远拿得到文本。
      return String(content);
    }
  }
  return String(content);
}

/**
 * 观测列表接口把 observation 的 input/output 作为原始 JSON 字符串下发（只有 trace 级 IO 在服务端解析过），
 * 这里防御性解析，让形状判定看到的是对象；非 JSON 字符串原样返回。
 */
export function parseMaybeString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * 归一化后的内容分片：一条消息里的一个可渲染单元，同时覆盖 Anthropic 的分片数组与 OpenAI 的字符串内容 +
 * 消息级 `tool_calls`。
 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id?: string; name: string; input: unknown }
  | { type: "tool_result"; id?: string; text: string }
  | { type: "image"; url?: string }
  | { type: "audio" }
  | { type: "unknown"; raw: unknown };

/**
 * 把消息的 content + tool_calls 摊平成统一的分片列表：
 * - OpenAI 形状：字符串 `content` + 消息级 `tool_calls[]`
 * - Anthropic 形状：`content` 分片数组（text / thinking / tool_use / tool_result / image / audio）
 */
export function extractParts(content: unknown, toolCalls?: unknown): ContentPart[] {
  const parts: ContentPart[] = [];
  if (typeof content === "string") {
    if (content) parts.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") {
        parts.push({ type: "text", text: part });
        continue;
      }
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      switch (p.type) {
        case "text":
          parts.push({ type: "text", text: typeof p.text === "string" ? p.text : "" });
          break;
        case "thinking":
          parts.push({ type: "thinking", text: typeof p.thinking === "string" ? p.thinking : "" });
          break;
        case "tool_use":
          parts.push({
            type: "tool_use",
            id: typeof p.id === "string" ? p.id : undefined,
            name: typeof p.name === "string" ? p.name : "tool",
            input: p.input,
          });
          break;
        case "tool_result":
          parts.push({
            type: "tool_result",
            id: typeof p.tool_use_id === "string" ? p.tool_use_id : undefined,
            text: contentToText(p.content),
          });
          break;
        case "image_url":
          parts.push({ type: "image", url: imageUrlToString(p.image_url) });
          break;
        case "input_audio":
          parts.push({ type: "audio" });
          break;
        default:
          parts.push({ type: "unknown", raw: part });
      }
    }
  } else if (typeof content === "object" && content !== null) {
    parts.push({ type: "unknown", raw: content });
  }
  // OpenAI 的 tool_calls 挂在消息上而不是 content 里，与 content 分片合并成同一条流，保持时序直觉。
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (typeof tc !== "object" || tc === null) continue;
      const fn = (tc as Record<string, unknown>).function ?? tc;
      const rec = fn as Record<string, unknown>;
      parts.push({
        type: "tool_use",
        name: typeof rec.name === "string" ? rec.name : "tool",
        input: rec.arguments,
      });
    }
  }
  return parts;
}

function imageUrlToString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const url = (value as Record<string, unknown>).url;
    return typeof url === "string" ? url : undefined;
  }
  return;
}

/** 角色是否在已知集合内。 */
export function isKnownRole(role: string): role is ChatRole {
  return KNOWN_ROLES.has(role);
}

/** 连续同角色消息合并成一块：一排工具结果各自撑一个气泡时噪音太大。 */
export function groupConsecutive(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (const msg of messages) {
    const last = groups[groups.length - 1];
    if (last && last[0].role === msg.role) {
      last.push(msg);
    } else {
      groups.push([msg]);
    }
  }
  return groups;
}
