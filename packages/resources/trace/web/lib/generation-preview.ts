/**
 * 助手文本预览提取。
 *
 * 移植来源：langfuse-lite `packages/web/src/shared/lib/generation-preview.ts`。
 *
 * 用途：列表行 / 摘要只需要一句「这次生成答了什么」，而输出形状有四种（纯文本、chat completion、Responses、
 * Anthropic）。工具参数、思维链与最终答案常常并排放在同一个输出对象里，所以这里按固定键序向下找**助手散文**，
 * 一旦 role 不是 assistant、或 type 命中 thinking/reasoning/tool/... 就返回空串——宁可预览为空，也不能把
 * 工具参数或思维链当成答案展示。
 *
 * 本次适配：import 路径改为本包的 `./chat-utils`；逻辑原样保留。
 */
import { parseMaybeString } from "./chat-utils";

function outputText(value: unknown, budget: number, depth = 0): string {
  // 深度与空值双闸：外部数据可能自引用或嵌套到病态深度，预览不需要为此付出代价。
  if (depth > 8 || value == null) return "";
  if (typeof value === "string") {
    const parsed = parseMaybeString(value);
    return parsed !== null && typeof parsed === "object"
      ? outputText(parsed, budget, depth + 1)
      : value.replace(/\s+/g, " ").trim().slice(0, budget);
  }
  if (Array.isArray(value)) {
    let text = "";
    for (const part of value.slice(0, 64)) {
      const next = outputText(part, budget - text.length, depth + 1);
      if (next) text += `${text ? " " : ""}${next}`;
      if (text.length >= budget) break;
    }
    return text;
  }
  if (typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  // 只预览助手散文：输入、工具参数/结果与推理是另外的载荷，即便与答案并排嵌套在同一个输出里也不该混进来。
  if (typeof record.role === "string" && record.role.toLowerCase() !== "assistant") return "";
  if (typeof record.type === "string" && /thinking|reasoning|tool|function|image|audio|input/.test(record.type)) {
    return "";
  }
  for (const key of ["output_text", "text", "content", "message", "messages", "choices", "output", "response"]) {
    const candidate = record[key];
    // Responses API 的 `{type:"output_text", text:{value}}` 形状：文本藏在 text.value 里。
    if (key === "text" && candidate && typeof candidate === "object" && "value" in candidate) {
      const text = outputText(candidate.value, budget, depth + 1);
      if (text) return text;
    }
    const text = outputText(candidate, budget, depth + 1);
    if (text) return text;
  }
  return "";
}

/** 纯文本 / chat completion / Responses / Anthropic 输出的首段助手文本；取不到返回 null。 */
export function getGenerationPreview(output: unknown, maxChars = 60): string | null {
  // 多读一个有界前缀：两个 UTF-16 单元覆盖一个码点，emoji 截断不会切出半个字符。
  const chars = Array.from(
    outputText(output, (maxChars + 1) * 2)
      .replace(/\s+/g, " ")
      .trim(),
  );
  if (!chars.length) return null;
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : chars.join("");
}
