/**
 * 知识库 HTML 片段的清洗收口（前端规范 §6.1「`dangerouslySetInnerHTML` 必须经 DOMPurify」/ §6.5）。
 *
 * 本包三处 `dangerouslySetInnerHTML`（docx 预览、切片详情、检索高亮）此前都走 **DOMPurify 默认配置**。
 * 默认白名单是「整本 HTML + SVG + MathML」——表单 / `input` / 内联 SVG / 媒体元素一并放行，等于把
 * 「这条链路真的会出现什么标签」的裁量权交给引擎。这里改成**按内容来源各给一份显式白名单**。
 *
 * 敢收紧的依据：DOMPurify 的默认行为是「剥标签、留文本」（`KEEP_CONTENT` 默认 true），漏掉某个标签的
 * 代价是**丢格式而不是丢内容**；URL 策略也不动（`img/source` 上的 `data:` 内联图仍可渲染——docx 与
 * RAGFlow 都会产出内联图，`href` 上的 `javascript:` 由引擎默认的 `ALLOWED_URI_REGEXP` 挡掉）。
 *
 * 两份白名单的取舍不同，不要互相套用：
 * - 高亮片段来自后端的**明确契约**（`src/server/schemas/knowledge.schema.ts` 写明「含 `<em>` 标签的
 *   HTML」），且只用于给检索命中加底色（`.retrieval-test-highlight em`，见同目录 CSS），所以收到最小集；
 * - 正文片段（RAGFlow 切片原文、mammoth 的 docx 输出）是**结构富文本**，白名单按「段落 / 标题 / 列表 /
 *   表格 / 内联图 / 链接」这类排版元素给足，只把表单、内联 SVG / MathML、iframe、媒体与脚本挡在外面。
 *
 * 注意：`class` 保留在两份白名单里（RAGFlow 与 mammoth 都会用类名表达表格 / 段落样式），因此**不**
 * 承担「阻断 Tailwind 类名注入」的职责；要挡那种 UI 伪装需另行裁定，不属本次收口。
 *
 * 四份白名单都导出，供 `web/__tests__/sanitize-html.test.ts` 逐项断言（包外不消费）。
 */

import DOMPurify from "dompurify";

/** 检索高亮：后端只产出 `<em>` 包住命中词，其余标签一律剥掉。 */
export const HIGHLIGHT_ALLOWED_TAGS = ["em", "span", "br"];

/** 检索高亮的属性：只留类名（高亮的视觉由外层 `.retrieval-test-highlight` 决定）。 */
export const HIGHLIGHT_ALLOWED_ATTR = ["class"];

/** 正文片段：排版结构 + 表格 + 内联图 + 链接，不含表单 / SVG / MathML / 媒体 / 脚本。 */
export const RICH_ALLOWED_TAGS = [
  "p",
  "br",
  "div",
  "span",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "caption",
  "colgroup",
  "col",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "blockquote",
  "pre",
  "code",
  "hr",
  "a",
  "img",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "s",
  "del",
  "ins",
  "mark",
  "small",
  "sub",
  "sup",
  "figure",
  "figcaption",
];

/** 正文片段的属性：链接 / 图片要用的地址与替代文本、表格的跨行列、类名与基础排版属性。 */
export const RICH_ALLOWED_ATTR = [
  "href",
  "src",
  "alt",
  "title",
  "colspan",
  "rowspan",
  "class",
  "width",
  "height",
  "align",
  "dir",
  "lang",
  "start",
];

/**
 * 清洗检索高亮片段（来源：RAGFlow 检索结果里的 `highlight` 字段，含知识库原文，不可信）。
 */
export function sanitizeHighlightHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: HIGHLIGHT_ALLOWED_TAGS,
    ALLOWED_ATTR: HIGHLIGHT_ALLOWED_ATTR,
  });
}

/**
 * 清洗结构富文本片段（来源：RAGFlow 切片原文 `content_with_weight`，以及 mammoth 对用户上传 docx 的
 * 转换结果——两者都可能携带任意标签与属性，不可信）。
 */
export function sanitizeRichHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: RICH_ALLOWED_TAGS,
    ALLOWED_ATTR: RICH_ALLOWED_ATTR,
  });
}
