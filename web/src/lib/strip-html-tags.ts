/**
 * 从会话标题中剔除 HTML 标签，仅保留纯文本。
 *
 * 背景：Agent 会话标题可能混入 `<system-reminder>`、`</system-reminder>` 等
 * 上下文标签（见 `context-queue.ts` 生成的提示块），直接展示会出现可见的标签文本。
 * React 自动转义已保证安全性（不会执行脚本），此工具只做显示层面的清洗，
 * 属于纯展示逻辑，不修改底层数据。
 *
 * 清洗规则：
 * - 成对的 `<system-reminder>` 块整体删除，包括块内内容：块内是系统上下文
 *   提示而非标题内容，删除后不残留（如 `<system-reminder>提示</system-reminder>`
 *   → 空）。若未来出现其他同性质的上下文标签块，在此追加即可。
 * - 截断的 `<system-reminder>` 块从开标签开始删除到字符串结尾，避免标题截断在
 *   系统上下文内部时残留 `Current permission mode: ...` 等内容。
 * - 其余标签（含孤立标签、带属性的标签）只剔除标签本身，保留标签间文本
 *   （如 `<p class="x"> 修复登录 </p>` → `修复登录`）。
 * - 仅识别形如 `<tag>` / `<tag attr=...>` / `</tag>` 的标签形态，避免误伤
 *   标题中的普通比较符号（如 "a < b"）。
 *
 * @param title 原始会话标题
 * @returns 清洗后的纯文本标题（已 trim；空输入返回空字符串）
 */
export function stripHtmlTags(title: string | null | undefined): string {
  if (!title) return "";
  return (
    title
      // 成对 system-reminder 块（含内容）整体删除
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
      // 截断的 system-reminder 块没有闭标签时，后续内容同样属于系统上下文
      .replace(/<system-reminder>[\s\S]*$/gi, "")
      // 剔除其余 HTML 标签（含孤立标签），保留标签间文本
      .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*[^>]*>/g, "")
      .trim()
  );
}

const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

/** 消息切分结果：system 段渲染为系统消息标签，text 段渲染为普通消息 */
export type ReminderSegment = { kind: "system" | "text"; text: string };

/**
 * 将消息文本切分为系统上下文段与普通文本段，供聊天渲染使用。
 *
 * 背景：注入的 `<system-reminder>` 上下文块（见 `context-queue.ts`）此前在渲染层
 * 被整体隐藏；现在改为渲染为"系统消息"标签（`SystemMessage`），hover 展示原始块，
 * 因此需要先切分。切分结果保留块文本（含标签），由 `SystemMessage` 原样展示。
 *
 * 切分规则：
 * - 完整的 `<system-reminder>...</system-reminder>` 块，无论位置都识别为系统段
 *   （块内是系统上下文而非消息内容；若未来出现其他同性质的上下文标签块，
 *   在此追加即可）。
 * - 未闭合的开标签仅在消息开头（发送方 unshift 的注入位置）时视为系统段；
 *   出现在其他位置属于用户输入（如用户询问 "请解释 <system-reminder> 标签的用途"），
 *   保留为文本段，避免把用户消息中合法包含的标签文本连同后续内容一起截断。
 *
 * @param text 原始消息文本
 * @returns 按出现顺序排列的切分段；空输入返回空数组
 */
export function splitSystemReminderBlocks(text: string): ReminderSegment[] {
  if (!text) return [];
  const segments: ReminderSegment[] = [];
  let rest = text.trim();
  while (rest) {
    const openIndex = rest.indexOf(SYSTEM_REMINDER_OPEN);
    if (openIndex < 0) {
      segments.push({ kind: "text", text: rest });
      break;
    }
    const closeIndex = rest.indexOf(SYSTEM_REMINDER_CLOSE, openIndex + SYSTEM_REMINDER_OPEN.length);
    if (closeIndex < 0) {
      // 未闭合的开标签：仅在消息开头视为注入的系统上下文，其余属于用户输入，
      // 连同前后内容整体保留为单个 text 段，避免改变用户输入的换行结构
      segments.push({ kind: openIndex === 0 ? "system" : "text", text: rest });
      break;
    }
    const before = rest.slice(0, openIndex).trim();
    if (before) segments.push({ kind: "text", text: before });
    segments.push({ kind: "system", text: rest.slice(openIndex, closeIndex + SYSTEM_REMINDER_CLOSE.length) });
    rest = rest.slice(closeIndex + SYSTEM_REMINDER_CLOSE.length).trim();
  }
  return segments;
}
