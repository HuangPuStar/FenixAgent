/**
 * 未闭合 `ui-spec` 围栏的文本补全（markdown 层，纯函数）。
 *
 * 背景：CommonMark 允许省略围栏闭合标记，此时该代码块的正文**一直延续到文档结尾**。模型输出
 * （或经用户转述的文本）常写成「```ui-spec + JSON + 后续说明文字」而不闭合，于是整篇后文都被归入
 * 这个代码块：JSON 里混进说明文字导致解析失败、整块降级为原文，同时后续正文在界面上一起消失。
 * 本模块在 markdown 解析**之前**给这类围栏补上闭合标记，恢复作者本意——JSON 回到围栏内，其余内容
 * 回到正文，两边都不丢。
 *
 * 约束（每一处都服务于「不猜测、不丢内容」）：
 * - 只处理**未闭合**且 info string 首词为 `ui-spec` 的围栏；已闭合的文本一字不动。语言比对与
 *   `UI_SPEC_PLUGINS` 的精确匹配口径一致（大小写敏感，取首词，与 streamdown 的语言提取一致）。
 * - 仅当围栏内容里能定位到**首个平衡的 JSON 对象**时才补全：从首个非空白字符起必须是 `{`，且
 *   括号配平（字符串状态与 `\` 转义都计入）。半截 JSON 一律保持原样，交给既有降级矩阵整块降级。
 * - 只**插入**闭合标记（与开标记等长的反引号独占一行），不删除、不改写任何既有字符——内容零丢失。
 * - 扫描口径对齐 CommonMark 的围栏规则（开标记行首 ≤3 空格缩进、info 不含反引号；闭合标记行首
 *   ≤3 空格缩进且只含反引号与空白、长度不短于开标记），与 remark 的块解析一致。`~` 围栏不处理：
 *   ui-spec 的既有写法与 skill 文档只用反引号，保守起见不扩大识别面。
 *
 * 调用时机由宿主决定：只在**非流式**（消息已定稿）时调用。流式中的未闭合是正常中间态，提前补全
 * 会让后续增量落到围栏外，正文与代码块来回跳变。
 */

import { UI_SPEC_LANGUAGE } from "./spec";

/** 合法开标记：行首 ≤3 空格 + ≥3 反引号 + 可选 info string。 */
const FENCE_OPEN_RE = /^( {0,3})(`{3,})([^\n]*)$/;
/** 合法闭合标记：行首 ≤3 空格 + ≥3 反引号 + 仅空白。 */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,})[ \t]*$/;

/**
 * 从 `from` 起找首个平衡的 JSON 对象，返回其结束偏移（`}` 的下一位）；找不到返回 `-1`。
 *
 * 字符串状态（含 `\` 转义）全程跟踪：字符串内的 `{}` 不参与配平，字符串内的裸换行（折行文本常见）
 * 也不影响配对——本函数只回答「JSON 到哪里结束」，不对内容做任何合法性判断。
 */
function findBalancedJsonObjectEnd(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/.test(text[index])) index++;
  if (text[index] !== "{") return -1;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * 给文档里**最后一个未闭合的 `ui-spec` 围栏**补上闭合标记；不满足补全条件时原样返回。
 *
 * 未闭合的围栏必然吞掉其后全部内容，因此文档里至多存在一个「待补全」候选（更早的未闭合块会把
 * 后面的开标记也吞进去，状态机会正确识别为仍在块内）。
 */
export function repairUnclosedUISpecFence(markdown: string): string {
  if (!markdown.includes("`")) return markdown;

  let lineStart = 0;
  let inFence = false;
  let fenceMarkerLength = 0;
  let fenceIsUISpec = false;
  let contentStart = -1;

  // 逐行状态机：与 CommonMark 一样「无嵌套」——块内只有「配平的闭合标记」能结束当前块。
  while (lineStart <= markdown.length) {
    const newline = markdown.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? markdown.length : newline;
    const line = markdown.slice(lineStart, lineEnd).replace(/\r$/, "");

    if (inFence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1].length >= fenceMarkerLength) {
        inFence = false;
        fenceIsUISpec = false;
        contentStart = -1;
      }
    } else {
      const open = FENCE_OPEN_RE.exec(line);
      // info string 含反引号时不是合法开标记（CommonMark 规定），按普通正文对待。
      if (open && !open[3].includes("`")) {
        inFence = true;
        fenceMarkerLength = open[2].length;
        fenceIsUISpec = open[3].trim().split(/\s+/)[0] === UI_SPEC_LANGUAGE;
        contentStart = newline === -1 ? markdown.length : newline + 1;
      }
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }

  if (!inFence || !fenceIsUISpec || contentStart < 0) return markdown;

  const jsonEnd = findBalancedJsonObjectEnd(markdown, contentStart);
  if (jsonEnd === -1) return markdown;

  const closing = "`".repeat(fenceMarkerLength);
  return `${markdown.slice(0, jsonEnd)}\n${closing}\n${markdown.slice(jsonEnd)}`;
}
