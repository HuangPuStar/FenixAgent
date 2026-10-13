// web/__tests__/sanitize-html.test.ts
// 知识库 HTML 清洗白名单守卫（前端规范 §6.1 / §6.5 的已收口项）。
//
// 被测的三处 `dangerouslySetInnerHTML` 输入分别是 RAGFlow 检索高亮、RAGFlow 切片原文与 mammoth 的
// docx 输出——都不可信（§6.1：UGC 与 Agent / LLM 输出同等对待）。本轮的收口点是「三处都用 DOMPurify
// 默认配置」→「按来源各给一份显式白名单」，因此本文件钉两件事：
//   1. 白名单内容：该来源真的会产出的标签在表内，危险标签（表单 / SVG / iframe / 媒体 / 脚本）不在；
//   2. 接线：三处调用点都改走 `web/lib/sanitize-html.ts` 的 helper，没有谁再用引擎默认配置。
//
// **这里刻意不写运行时行为断言**：DOMPurify 3.4.11 与 happy-dom 20 有两处实测不兼容，任一条都会让
// 「渲染后 HTML」的断言测出桩行为而不是生产行为——
//   a. 标签名：DOMPurify 用 `lookupGetter(Node.prototype, 'nodeName')` 缓存跨 realm 的取值器，而
//      happy-dom 把 `nodeName` / `nodeType` 的可访问实现放在**子类**原型上，直接调基类取值器得到
//      `""`（实测 `Object.getOwnPropertyDescriptor(window.Node.prototype,'nodeName').get.call(body) === ''`
//      而 `body.nodeName === 'BODY'`）→ 所有节点都被当成「标签不在白名单」。
//   b. 遍历：把 a 修好后再测，happy-dom 的 NodeIterator 在**首次节点移除后即中止**（`<p>1</p><script>2</script>`
//      能正确剥掉 script，但 `<script>1</script><img onerror=…>` 的第二个节点就不再看），DOMPurify 的
//      遍历依赖「迭代期间可安全改写 DOM」这条规范语义。
// 真实浏览器走的是规范实现，两处都不成立，故三处调用点的线上行为不受影响；本文件因此只断言白名单本身。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HIGHLIGHT_ALLOWED_ATTR,
  HIGHLIGHT_ALLOWED_TAGS,
  RICH_ALLOWED_ATTR,
  RICH_ALLOWED_TAGS,
} from "../lib/sanitize-html";

const WEB_ROOT = join(import.meta.dirname, "..");
/** 三处 `dangerouslySetInnerHTML` 的宿主文件（包内相对路径）。 */
const CALL_SITES = [
  "components/knowledge/ResourcePreviewContent.tsx",
  "src/pages/agent-panel/components/ChunkDetailSheet.tsx",
  // 检索结果卡片：§4.7 拆分后 `HighlightSpan` 随单条结果卡片移到本文件（原为 RetrievalTestPanel.tsx）
  "src/pages/agent-panel/components/retrieval-chunk-card.tsx",
];
/** 默认配置会放行、这三条链路的正文里绝不该出现的标签。 */
const DANGEROUS_TAGS = ["script", "style", "iframe", "form", "input", "button", "svg", "video", "object", "embed"];

describe("knowledge HTML 清洗白名单", () => {
  // 高亮片段只承载后端契约里的 <em>（外加 span/br 包一层），是最小集；宽一位就等于把表单 / 图片 /
  // 内联 SVG 也放进检索结果这个高频渲染路径。
  test("高亮白名单只含 em/span/br 与 class，不含任何危险标签", () => {
    expect([...HIGHLIGHT_ALLOWED_TAGS].sort()).toEqual(["br", "em", "span"]);
    expect(HIGHLIGHT_ALLOWED_ATTR).toEqual(["class"]);
    for (const tag of [...DANGEROUS_TAGS, "a", "img", "table"]) {
      expect(HIGHLIGHT_ALLOWED_TAGS).not.toContain(tag);
    }
  });

  // 正文片段（切片原文 / docx）是结构富文本：段落、标题、列表、表格、内联图、链接必须留在白名单里，
  // 否则收紧就变成渲染回归（DOMPurify 会剥掉标签只留文本）。
  test("正文白名单保留排版结构、表格、链接与内联图", () => {
    for (const tag of [
      "p",
      "br",
      "h1",
      "h2",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
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
      "em",
    ]) {
      expect(RICH_ALLOWED_TAGS).toContain(tag);
    }
    for (const attr of ["href", "src", "alt", "title", "colspan", "rowspan", "class"]) {
      expect(RICH_ALLOWED_ATTR).toContain(attr);
    }
  });

  // 收紧的主要收益：默认配置放行的表单、内联 SVG / MathML、iframe、媒体与样式表全部挡在外面。
  test("正文白名单不含危险标签", () => {
    for (const tag of DANGEROUS_TAGS) {
      expect(RICH_ALLOWED_TAGS).not.toContain(tag);
    }
  });

  // 事件属性（on*）与内联 style 不在属性白名单里：前者是 XSS 载荷，后者可做全屏遮罩式的 UI 伪装。
  test("正文属性白名单不含事件属性与内联 style", () => {
    expect(RICH_ALLOWED_ATTR).not.toContain("style");
    for (const attr of RICH_ALLOWED_ATTR) {
      expect(attr.startsWith("on")).toBe(false);
    }
  });

  // 接线断言：三处调用点必须走 helper（helper 内部把白名单显式交给 DOMPurify），
  // 谁再直接 `import DOMPurify` 用默认配置就等于把本条收口回退。
  test("三处 dangerouslySetInnerHTML 都经 lib/sanitize-html，无直连 DOMPurify", () => {
    for (const relativePath of CALL_SITES) {
      const source = readFileSync(join(WEB_ROOT, relativePath), "utf8");
      expect(source).toContain("sanitize-html");
      expect(source).not.toContain('from "dompurify"');
    }
  });

  // helper 自身必须把两份白名单传给 DOMPurify——只声明常量而不接线同样是「默认配置」。
  test("helper 把显式白名单传给 DOMPurify.sanitize", () => {
    const source = readFileSync(join(WEB_ROOT, "lib/sanitize-html.ts"), "utf8");
    expect(source.match(/ALLOWED_TAGS: [A-Z_]+ALLOWED_TAGS/g) ?? []).toHaveLength(2);
    expect(source.match(/ALLOWED_ATTR: [A-Z_]+ALLOWED_ATTR/g) ?? []).toHaveLength(2);
  });
});
