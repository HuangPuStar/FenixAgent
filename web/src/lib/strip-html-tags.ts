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
      // 剔除其余 HTML 标签（含孤立标签），保留标签间文本
      .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*[^>]*>/g, "")
      .trim()
  );
}
