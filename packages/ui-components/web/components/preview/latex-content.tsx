/**
 * LaTeX 文档的 React 渲染层：块序列（`latex-document.ts` 解析）→ DOM，公式交给 KaTeX。
 *
 * 为什么是 React 而不是 `@open-file-viewer` 插件：插件直接操作 DOM、拿不到 React 上下文（
 * `html-plugin` 的标签文案因此写死中文，见包 README 已知限制第 12 条）。LaTeX 预览有降级提示与
 * 「渲染 / 源码」两个本地化文案面，走 React 才能用 `t()`，也不必再扩插件契约。
 *
 * 降级策略（要求：不支持的宏不得白屏）：
 * 1. 先按 `throwOnError: true` 渲染一次——用 KaTeX 自己的解析结果判断公式是否完全受支持，比事后嗅探
 *    输出 HTML 里的错误标记可靠（KaTeX 对「未知宏」与「未知环境」的错误标记并不同构）。
 * 2. 解析失败时改用 `throwOnError: false` 重渲染：KaTeX 把不支持的宏渲染成错误色原文，公式仍在原位，
 *    并给出一条本地化提示说明是宏不受支持而不是文件坏了。
 * 3. 连 `throwOnError: false` 都抛出时（畸形输入、超深嵌套）按公式粒度回退**源码**：一条公式坏掉，
 *    其余段落照常渲染。原始错误只进 `console.error`，不上屏（§7.2）。
 *
 * 渲染选项（`strict` / `trust` / `errorColor` / `macros`）与错误色取自 `lib/katex-math`：那是 KaTeX 策略的
 * 唯一真相，聊天渲染链（`@streamdown/math` → rehype-katex）用的是同一份常量，两边不得各写一套。
 * 样式表同样只在那里引入（`loadKatexStyles`），本文件不再自己 `import` CSS。
 *
 * 本模块静态依赖 KaTeX（JS 本体），由 `DocumentPreview` 动态导入，只有真正预览 `.tex` 时才会加载。
 */

import katex from "katex";
import { Fragment, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { cn } from "../../lib/cn";
import { katexRenderOptions, loadKatexStyles } from "../../lib/katex-math";
import type { LatexBlock, LatexInline } from "./latex-document";
import { parseLatexDocument } from "./latex-document";

// KaTeX 样式表：经共享模块按需加载（本模块本身就是动态 chunk，加载时机与数学渲染一致）
void loadKatexStyles();

/** 标题层级 → 语义标签（`.tex` 的 `\part` / `\chapter` 归一为一级）。 */
const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5"] as const;

const HEADING_CLASS: Record<number, string> = {
  1: "text-base font-semibold text-text-bright",
  2: "text-sm font-semibold text-text-bright",
  3: "text-sm font-semibold",
  4: "text-sm font-medium",
  5: "text-sm font-medium text-text-secondary",
};

export interface LatexPreviewProps {
  /** `.tex` 正文（已按 BOM 解码）。 */
  text: string;
}

/** 解析并按块渲染一篇 LaTeX 文档。 */
export function LatexPreview({ text }: LatexPreviewProps) {
  const document = useMemo(() => parseLatexDocument(text), [text]);
  return <LatexBlocks blocks={document.blocks} />;
}

function LatexBlocks({ blocks }: { blocks: LatexBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 块没有稳定 id（解析结果里位置即身份）；整篇文档换文件时整体重建、不重排，索引键不会引起元素错位。
        <Fragment key={index}>{renderBlock(block)}</Fragment>
      ))}
    </>
  );
}

function renderBlock(block: LatexBlock) {
  switch (block.kind) {
    case "title":
      return (
        <header className="mb-4 border-b border-border pb-3">
          <h1 className="text-base font-semibold text-text-bright">
            <LatexInlineNodes nodes={block.title} />
          </h1>
          {(block.author.length > 0 || block.date.length > 0) && (
            <p className="mt-1 text-xs text-text-muted">
              <LatexInlineNodes nodes={block.author} />
              {block.author.length > 0 && block.date.length > 0 && " · "}
              <LatexInlineNodes nodes={block.date} />
            </p>
          )}
        </header>
      );
    case "heading": {
      const level = Math.min(Math.max(block.level, 1), HEADING_TAGS.length);
      const Heading = HEADING_TAGS[level - 1] ?? "h3";
      return (
        <Heading className={cn("mt-4 mb-1", HEADING_CLASS[level])}>
          <LatexInlineNodes nodes={block.children} />
        </Heading>
      );
    }
    case "paragraph":
      return (
        <p className="my-2 leading-relaxed">
          <LatexInlineNodes nodes={block.children} />
        </p>
      );
    case "displayMath":
      return (
        <div className="my-2 overflow-x-auto text-center">
          <LatexMath source={block.source} display />
        </div>
      );
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List className={cn("my-2 space-y-1 pl-5", block.ordered ? "list-decimal" : "list-disc")}>
          {block.items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 同上——列表项只有位置身份。
            <li key={index}>
              <LatexBlocks blocks={item} />
            </li>
          ))}
        </List>
      );
    }
    case "table":
      return (
        <div className="my-3 overflow-x-auto">
          <table className="border-collapse text-xs">
            <tbody>
              {block.rows.map((row, rowIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同上——表格行只有位置身份。
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 同上——单元格身份就是 (行, 列) 位置。
                    <td key={cellIndex} className="border border-border px-2 py-1 align-top">
                      <LatexInlineNodes nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "verbatim":
      return (
        <pre className="my-2 overflow-x-auto rounded-md bg-surface-0 p-2 font-mono text-xs leading-relaxed">
          {block.text.replace(/^\n/, "")}
        </pre>
      );
    case "quote":
      return (
        <blockquote className="my-2 border-l-2 border-border pl-3 text-text-secondary">
          <LatexBlocks blocks={block.blocks} />
        </blockquote>
      );
  }
}

function LatexInlineNodes({ nodes }: { nodes: LatexInline[] }) {
  return (
    <>
      {nodes.map((node, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 同上——行内节点只有位置身份（同一段落在重建时整体替换）。
        <Fragment key={index}>{renderInline(node)}</Fragment>
      ))}
    </>
  );
}

function renderInline(node: LatexInline) {
  switch (node.kind) {
    case "text":
      return node.value;
    case "lineBreak":
      return <br />;
    case "strong":
      return (
        <strong className="font-semibold text-text-bright">
          <LatexInlineNodes nodes={node.children} />
        </strong>
      );
    case "emphasis":
      return (
        <em>
          <LatexInlineNodes nodes={node.children} />
        </em>
      );
    case "code":
      return <code className="rounded bg-surface-0 px-1 font-mono text-xs">{flattenText(node.children)}</code>;
    case "math":
      return <LatexMath source={node.source} display={node.display} />;
  }
}

/** 行内等宽样式只承载文字：块内不再递归渲染公式，避免 `\texttt` 里出现排版元素。 */
function flattenText(nodes: LatexInline[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "text") return node.value;
      if (node.kind === "lineBreak") return " ";
      if (node.kind === "math") return `$${node.source}$`;
      return flattenText(node.children);
    })
    .join("");
}

/** 一次公式渲染的结果：`html` 为渲染产物，`unsupported` 表示 KaTeX 没能完整解析该公式。 */
interface RenderedMath {
  html: string;
  unsupported: boolean;
}

/** 单条公式的渲染结果：`null` 表示连错误态渲染都失败，调用方回退源码展示。 */
function renderMath(source: string, display: boolean): RenderedMath | null {
  try {
    return {
      html: katex.renderToString(source, katexRenderOptions({ displayMode: display, throwOnError: true })),
      unsupported: false,
    };
  } catch (error) {
    // 未知宏 / 未知环境：先在日志里留下 KaTeX 的定位信息，再用错误态渲染保住内容
    console.warn("[LatexPreview] KaTeX 无法完整解析公式，改按错误态渲染", error);
    try {
      return {
        html: katex.renderToString(source, katexRenderOptions({ displayMode: display, throwOnError: false })),
        unsupported: true,
      };
    } catch (fallbackError) {
      console.error("[LatexPreview] KaTeX 渲染失败，回退源码展示", fallbackError);
      return null;
    }
  }
}

function LatexMath({ source, display }: { source: string; display: boolean }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const rendered = useMemo(() => renderMath(source, display), [source, display]);

  if (rendered === null) {
    return (
      <span className={cn("inline-flex flex-wrap items-center gap-1", display && "justify-center")}>
        <code className="rounded bg-surface-0 px-1 font-mono text-xs">{source}</code>
        <span className="text-xs text-red-500">{t("fileTree.preview.mathRenderFailed")}</span>
      </span>
    );
  }

  return (
    <span className={cn("inline-block max-w-full align-middle", display && "block text-left")}>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: 注入的是 KaTeX 生成的排版标记；输入侧由 KaTeX 转义，且 trust:false 关掉了 \href / \htmlClass 之类的原始 HTML 通道 */}
      <span dangerouslySetInnerHTML={{ __html: rendered.html }} />
      {rendered.unsupported && (
        <span className="ml-1 text-xs text-red-500">{t("fileTree.preview.mathUnsupported")}</span>
      )}
    </span>
  );
}
