// web/__tests__/latex-document.test.ts
// `.tex` 结构解析的契约测试（2026-10-15 文档预览批次）。
//
// 为什么单独钉住解析层：`.tex` 预览的质量全在「段落 / 章节 / 列表 / 公式 / 逐字环境」这五类块切得对不对，
// 渲染层只是把块贴到 DOM 上。解析是纯函数，用例直接断言块序列，不经过 KaTeX 与 DOM。
//
// 其中「列表之后的章节仍要解析」是**真实缺陷的回归用例**：项内解析若把 `\end{itemize}` 消费掉，
// 列表循环会一路扫到文末，把后续内容全吞进最后一项（首个列表之后整篇消失）。

import { describe, expect, test } from "bun:test";
import { type LatexBlock, type LatexInline, parseLatexDocument } from "../components/preview/latex-document";

/** 取块序列的 kind 列表：断言结构骨架时最直观。 */
function kinds(blocks: LatexBlock[]): string[] {
  return blocks.map((block) => block.kind);
}

/** 取行内节点的类型列表：断言公式与样式是否被识别。 */
function inlineKinds(nodes: LatexInline[]): string[] {
  return nodes.map((node) => node.kind);
}

describe("LaTeX 文档解析 — 元信息与标题", () => {
  // 导言区的 \title / \author / \date 是论文标题的来源，且标题块要排在正文之前
  test("导言区元信息成为首个标题块", () => {
    const document = parseLatexDocument(
      String.raw`\documentclass{article}
\title{A \textbf{Short} Paper}
\author{Alice \and Bob}
\begin{document}
Body text.
\end{document}`,
    );

    expect(document.blocks[0]?.kind).toBe("title");
    const title = document.blocks[0];
    if (title?.kind !== "title") throw new Error("首块应是标题块");
    expect(inlineKinds(title.title)).toEqual(["text", "strong", "text"]);
    // `\and` 是作者分隔宏，丢掉会让两个作者名粘在一起
    expect(JSON.stringify(title.author)).toContain("Alice");
    expect(JSON.stringify(title.author)).toContain("Bob");
    // 导言区的 \documentclass / \usepackage 不得漏进正文
    expect(JSON.stringify(document.blocks)).not.toContain("documentclass");
    expect(JSON.stringify(document.blocks)).not.toContain("usepackage");
  });

  // 片段式 .tex（没有 \begin{document}）也要能解析：LLM 常直接给章节正文
  test("缺少 document 环境时整篇按正文解析", () => {
    const document = parseLatexDocument(String.raw`\section{Only Section}
Text.`);

    expect(kinds(document.blocks)).toEqual(["heading", "paragraph"]);
  });
});

describe("LaTeX 文档解析 — 章节层级", () => {
  // 章节命令要映射到标题层级，带星号的无编号变体与本体同层
  test("section / subsection / section* 映射到标题层级", () => {
    const document = parseLatexDocument(String.raw`\section{A}
\subsection{B}
\subsubsection{C}
\section*{D}`);

    expect(document.blocks.map((block) => (block.kind === "heading" ? block.level : null))).toEqual([2, 3, 4, 2]);
  });
});

describe("LaTeX 文档解析 — 公式", () => {
  // 行内公式与行间公式都要按原文保留，交给 KaTeX
  test("行内、行间公式与数学环境各自成块", () => {
    const document = parseLatexDocument(String.raw`Inline $a_i + b^2$ text.
\[
  \alpha \quad \beta
\]
\begin{equation}
  E = mc^2
\end{equation}
$$x + y$$`);

    expect(kinds(document.blocks)).toEqual(["paragraph", "displayMath", "displayMath", "displayMath"]);
    const paragraph = document.blocks[0];
    if (paragraph?.kind !== "paragraph") throw new Error("首块应是段落");
    expect(inlineKinds(paragraph.children)).toEqual(["text", "math", "text"]);
    // 数学环境按原文（含 \begin/\end）交给 KaTeX：KaTeX 自己能识别这些环境
    const equation = document.blocks[2];
    if (equation?.kind !== "displayMath") throw new Error("第三块应是行间公式");
    expect(equation.source).toContain("\\begin{equation}");
    expect(equation.source).toContain("\\end{equation}");
  });

  // 未闭合的数学环境不能吞掉整篇文档：解析要收尾，内容按剩余部分交给 KaTeX
  test("未闭合的数学环境读到文末即收尾", () => {
    const document = parseLatexDocument(String.raw`\begin{equation}
  x = 1`);

    expect(kinds(document.blocks)).toEqual(["displayMath"]);
  });

  // `.tex` 里的 `$` 没有货币含义，但仍要求成对：单侧 `$` 按普通字符处理，避免吞掉后文
  test("缺少配对定界符的 $ 按普通字符处理", () => {
    const document = parseLatexDocument("Costs $100 and keeps going.");

    expect(kinds(document.blocks)).toEqual(["paragraph"]);
    const paragraph = document.blocks[0];
    if (paragraph?.kind !== "paragraph") throw new Error("首块应是段落");
    expect(JSON.stringify(paragraph.children)).toContain("Costs $100 and keeps going.");
  });
});

describe("LaTeX 文档解析 — 列表", () => {
  // 列表项内容是块序列，嵌套列表因此能自然递归
  test("itemize / enumerate / description 与嵌套列表", () => {
    const document = parseLatexDocument(String.raw`\begin{itemize}
  \item first
  \item second
    \begin{enumerate}
      \item nested
    \end{enumerate}
\end{itemize}
\begin{description}
  \item[Term] definition
\end{description}`);

    const list = document.blocks[0];
    if (list?.kind !== "list") throw new Error("首块应是列表");
    expect(list.ordered).toBe(false);
    expect(list.items.length).toBe(2);
    // 第二项里嵌着有序列表
    expect(kinds(list.items[1] ?? [])).toEqual(["paragraph", "list"]);
    const description = document.blocks[1];
    if (description?.kind !== "list") throw new Error("第二块应是列表");
    // description 的 `\item[Term]` 标签单独成段，便于界定术语与释义
    expect(JSON.stringify(description.items[0]?.[0])).toContain('"strong"');
  });

  // 回归：列表项内的解析**不得**消费 `\end{itemize}`，否则列表循环会扫到文末、吞掉后续章节
  test("列表之后的章节仍被解析（项内不消费结束标记）", () => {
    const document = parseLatexDocument(String.raw`\begin{itemize}
  \item first
\end{itemize}
\section{After List}
Tail text.`);

    expect(kinds(document.blocks)).toEqual(["list", "heading", "paragraph"]);
  });
});

describe("LaTeX 文档解析 — 逐字环境与表格", () => {
  // 逐字环境里的 `%` 是内容不是注释；内容要原样保留
  test("verbatim 保留注释符原文", () => {
    const document = parseLatexDocument(String.raw`\begin{verbatim}
echo %PATH%
\end{verbatim}`);

    const verbatim = document.blocks[0];
    if (verbatim?.kind !== "verbatim") throw new Error("首块应是逐字块");
    expect(verbatim.text).toContain("echo %PATH%");
  });

  // 表格按 `&` 分列、`\\` 分行，列格式与横线丢弃
  test("tabular 切成行列，横线不进入单元格", () => {
    const document = parseLatexDocument(String.raw`\begin{tabular}{l|r}
  \hline
  Name & Value \\
  \hline
  a & 1 \\
  \hline
\end{tabular}`);

    const table = document.blocks[0];
    if (table?.kind !== "table") throw new Error("首块应是表格");
    expect(table.rows.length).toBe(2);
    expect(table.rows[0]?.length).toBe(2);
    expect(JSON.stringify(table.rows)).not.toContain("hline");
  });
});

describe("LaTeX 文档解析 — 正文与降级", () => {
  // 段落里的注释必须剔除：留下 `% 注释` 会把源文件的写作痕迹当成正文
  test("段落内的注释被剔除，空行断段", () => {
    const document = parseLatexDocument(`First line.
% a comment
Second line.

Another paragraph.`);

    expect(kinds(document.blocks)).toEqual(["paragraph", "paragraph"]);
    expect(JSON.stringify(document.blocks[0])).not.toContain("a comment");
    expect(JSON.stringify(document.blocks[0])).toContain("Second line");
  });

  // 转义的百分号是正文，不能被当注释删掉
  test("转义的 \\% 保留为字符", () => {
    const document = parseLatexDocument(String.raw`Progress is 50\% done.`);

    expect(JSON.stringify(document.blocks[0])).toContain("50% done");
  });

  // 未识别的宏丢宏名、留正文：宁可少一段样式，也不能让作者写的内容消失
  test("未知宏保留其参数正文", () => {
    const document = parseLatexDocument(String.raw`\unknownmacro{kept text}`);

    expect(kinds(document.blocks)).toEqual(["paragraph"]);
    expect(JSON.stringify(document.blocks[0])).toContain("kept text");
  });

  // 引用没有编号可还原，按 `[键]` 呈现：读者至少知道此处有引用
  test("ref / cite 渲染为方括号键", () => {
    const document = parseLatexDocument("See~\\ref{sec:intro} and~\\cite{knuth1984}.");

    const text = JSON.stringify(document.blocks[0]);
    expect(text).toContain("[sec:intro]");
    expect(text).toContain("[knuth1984]");
  });

  // 字符级样式命令映射到行内节点，供渲染层出粗体 / 斜体 / 等宽
  test("text 类样式命令映射为行内节点", () => {
    const document = parseLatexDocument(String.raw`\textbf{bold} \emph{italic} \texttt{mono}`);

    const paragraph = document.blocks[0];
    if (paragraph?.kind !== "paragraph") throw new Error("首块应是段落");
    expect(inlineKinds(paragraph.children)).toContain("strong");
    expect(inlineKinds(paragraph.children)).toContain("emphasis");
    expect(inlineKinds(paragraph.children)).toContain("code");
  });
});
