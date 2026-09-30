import { expect, test } from "bun:test";

import { findCssComments, isTightlyEmbeddedComment, removeCssComments, summarizeCssComment } from "../lib/css-comments";

/**
 * CSS 注释移除的自测。
 *
 * 锁住三类口径：字符串与 `url()` 里的斜杠星号不是注释；独行注释连行删除、
 * 行内注释最多补一个空格（CSS 注释不产生空白 token，删干净会把两侧粘成新 token）；
 * `keep` 命中的注释原样保留且不被删除区间吞掉。
 */

// 独行注释整行删除：注释行不残留为空白行。
test("独行注释连同行首缩进与行尾换行一起删除", () => {
  const source = "a {\n  /* 说明 */\n  color: red;\n}\n";
  expect(removeCssComments(source).output).toBe("a {\n  color: red;\n}\n");
});

// 跨行的注释块（含首行 `/*` 与末行 `*/`）整体消失，不留下残行。
test("多行注释块整体删除", () => {
  const source = "a {\n  /* 第一行\n     第二行 */\n  color: red;\n}\n";
  expect(removeCssComments(source).output).toBe("a {\n  color: red;\n}\n");
});

// 仅由空白分隔的连续注释合并处理：注释块之间的空行一并清掉，不留成片空行。
test("相邻注释之间的空行一并清掉", () => {
  const source = "a {}\n\n/* 甲 */\n\n/* 乙 */\n\nb {}\n";
  expect(removeCssComments(source).output).toBe("a {}\n\nb {}\n");
});

// 文件尾部注释前若有空行，删除时一起吸收，不在文件末尾留孤立空行。
test("尾部注释连同其前的空行一起删除", () => {
  expect(removeCssComments("a {}\n\n/* 尾部说明 */\n").output).toBe("a {}\n");
});

// 行内注释两侧已有空白：删除后不额外补空格，多余空白交给 biome format 收尾。
test("行内注释两侧有空白时不新增空格", () => {
  expect(removeCssComments(".a /* x */ .b {}").output).toBe(".a  .b {}");
});

// 两侧都紧贴非空白字符：补一个空格保住 token 边界（取舍见 lib 头部第 3 条）。
test("两侧紧邻非空白的注释替换为单个空格", () => {
  expect(removeCssComments("width: 1px/* x */solid;").output).toBe("width: 1px solid;");
  expect(isTightlyEmbeddedComment("width: 1px/* x */solid;", findCssComments("width: 1px/* x */solid;")[0]!)).toBe(
    true,
  );
});

// 字符串字面量里的斜杠星号不是注释，必须原样保留。
test("字符串内容不被当成注释", () => {
  const source = 'a::before { content: "/* 不是注释 */"; }\n';
  const removal = removeCssComments(source);
  expect(removal.output).toBe(source);
  expect(removal.removed).toHaveLength(0);
});

// 未加引号与加引号的 url() 内容都不是注释，必须原样保留。
test("url() 内容不被当成注释", () => {
  const bare = "a { background: url(/assets/a/*.png); }\n";
  const quoted = 'a { background: url("/assets/a/*.png"); }\n';
  expect(removeCssComments(bare).output).toBe(bare);
  expect(removeCssComments(quoted).output).toBe(quoted);
});

// keep 命中的注释原样保留，且它前后的删除区间不得把它一起吞掉。
test("keep 命中的注释原样保留", () => {
  const source = "/* biome-ignore lint/x: 理由 */\n/* 说明 */\na { color: red; }\n";
  const removal = removeCssComments(source, { keep: (comment) => comment.text.startsWith("/* biome-ignore") });

  expect(removal.output).toBe("/* biome-ignore lint/x: 理由 */\na { color: red; }\n");
  expect(removal.removed.map((comment) => comment.line)).toEqual([2]);
  expect(removal.kept.map((comment) => comment.line)).toEqual([1]);
});

// 删除是幂等的：对结果再跑一次不再变化，也不会凭空补空格。
test("重复删除不产生二次变化", () => {
  const source = "a {\n  /* 说明 */\n  color: red; /* 行内 */\n}\n";
  const once = removeCssComments(source).output;
  const twice = removeCssComments(once);
  expect(twice.output).toBe(once);
  expect(twice.removed).toHaveLength(0);
});

// 未闭合注释吞到文件末尾，不会把后面的内容误判为代码。
test("未闭合注释删除到文件末尾", () => {
  const removal = removeCssComments("a { color: red; }\n/* 未闭合\ncolor: blue;\n");
  expect(removal.output).toBe("a { color: red; }\n");
  expect(removal.removed).toHaveLength(1);
});

// 摘要用于扫描报告：取首行正文、去掉装饰星号、超长截断。
test("摘要取注释首行正文", () => {
  const [comment] = findCssComments("/*\n * 多行说明\n * 第二行\n */\n");
  expect(summarizeCssComment(comment!)).toBe("多行说明");
});
