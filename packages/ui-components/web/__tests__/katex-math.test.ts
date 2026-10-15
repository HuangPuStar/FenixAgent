// web/__tests__/katex-math.test.ts
// 「KaTeX 策略只有一份」的守护（2026-10-15 数学渲染批次）。
//
// 背景：仓库里有两条数学渲染链——聊天正文（streamdown + `@streamdown/math` → remark-math /
// rehype-katex）与文件预览（`.md` 走 KaTeX auto-render、`.tex` 走 `renderToString`）。它们**必须**共用
// `lib/katex-math` 的策略：单 `$` 判定、错误色、降级选项、样式表引入点。分叉不会报错，只会让两条链
// 在用户面前表现不一致（同一条消息里的公式与预览里的公式一个渲染一个不渲染），所以用静态断言钉住。
//
// 断言分两类：① 聊天插件的实际选项值来自共享常量；② 共享模块之外不再出现这些选项字面量与 CSS 引入。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createChatKatexPlugin } from "../chat/ui-spec/math-plugin";
import {
  KATEX_AUTO_RENDER_DELIMITERS,
  KATEX_ERROR_COLOR,
  KATEX_MACROS,
  KATEX_SINGLE_DOLLAR_TEXT_MATH,
  katexRenderOptions,
  loadKatexStyles,
} from "../lib/katex-math";

const WEB_ROOT = join(import.meta.dir, "..");
const SHARED_MODULE = "lib/katex-math.ts";

/** 递归收集 web 下的生产源码（排除测试与字典）。 */
function collectSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "__tests__" || entry === "locales") continue;
      files.push(...collectSources(path));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(path);
    }
  }
  return files;
}

/** 在哪些文件里出现过该字面量（web 相对路径）。 */
function filesContaining(text: string): string[] {
  return collectSources(WEB_ROOT)
    .filter((file) => stripComments(readFileSync(file, "utf8")).includes(text))
    .map((file) => relative(WEB_ROOT, file))
    .sort();
}

/** 剥掉块注释与行注释：静态断言只针对生效代码，说明文字不参与判定（同 `preview-fetch-injection.test.ts`）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 某个选项键的每一处生效写法：所在文件 + 该行文本（用于判断是否引用了共享常量）。 */
function optionUsages(key: string): { file: string; line: string }[] {
  return collectSources(WEB_ROOT).flatMap((file) =>
    stripComments(readFileSync(file, "utf8"))
      .split("\n")
      .filter((line) => line.includes(key))
      .map((line) => ({ file: relative(WEB_ROOT, file), line })),
  );
}

/** 共享模块之外，选项键的每一处写法都必须引用对应的共享常量（引用即不是「另写一份」）。 */
function forkedUsages(key: string, sharedConstant: string): string[] {
  return optionUsages(key)
    .filter((usage) => usage.file !== SHARED_MODULE && !usage.line.includes(sharedConstant))
    .map((usage) => `${usage.file}: ${usage.line.trim()}`);
}

describe("KaTeX 策略单一来源", () => {
  // 聊天插件必须用共享常量构造：单 `$` 与错误色两项如果各写一份，聊天与预览就会对同一条正文给出不同结果
  test("聊天插件的选项来自共享常量", () => {
    const plugin = createChatKatexPlugin();

    expect(plugin.name).toBe("katex");
    expect(JSON.stringify(plugin.remarkPlugin)).toContain(`"singleDollarTextMath":${KATEX_SINGLE_DOLLAR_TEXT_MATH}`);
    expect(JSON.stringify(plugin.rehypePlugin)).toContain(KATEX_ERROR_COLOR);
  });

  // auto-render 的定界符表跟着同一个开关走：关掉单 `$` 时列表里就不该有它
  test("预览的自动渲染定界符跟随单 $ 开关", () => {
    const hasSingleDollar = KATEX_AUTO_RENDER_DELIMITERS.some(
      (delimiter) => delimiter.left === "$" && delimiter.right === "$",
    );

    expect(hasSingleDollar).toBe(KATEX_SINGLE_DOLLAR_TEXT_MATH);
    // `$$` 必须排在 `$` 之前：自动渲染按顺序取第一个命中的定界符
    expect(KATEX_AUTO_RENDER_DELIMITERS[0]).toEqual({ left: "$$", right: "$$", display: true });
    // 传 delimiters 会整份替换 KaTeX 默认列表，AMS 那几条要跟着写进来
    expect(KATEX_AUTO_RENDER_DELIMITERS.some((delimiter) => delimiter.left === "\\begin{equation}")).toBe(true);
  });

  // 预览的 renderToString 选项：错误色与宏来自共享常量，trust 固定关闭（预览内容是 UGC）
  test("预览渲染选项来自共享常量且关闭 trust", () => {
    const options = katexRenderOptions({ displayMode: true, throwOnError: false });

    expect(options.errorColor).toBe(KATEX_ERROR_COLOR);
    expect(options.macros).toEqual({ ...KATEX_MACROS });
    expect(options.displayMode).toBe(true);
    expect(options.throwOnError).toBe(false);
    expect(options.trust).toBe(false);
  });

  // 样式表只能从这里引入：多一处 `import "katex/dist/katex.min.css"` 就会多一份样式表副本进 chunk
  test("KaTeX 样式表只在共享模块引入", () => {
    expect(filesContaining("katex/dist/katex.min.css")).toEqual([SHARED_MODULE]);
    // 引入点的行为自检：调用方拿到的是动态导入（CSS 随所在 chunk 懒加载）
    expect(loadKatexStyles()).toBeInstanceOf(Promise);
  });

  // 选项值不得在别处复制：共享模块之外只允许出现「引用共享常量」的写法
  test("选项值只在共享模块定义，消费方只引常量", () => {
    // 错误色字面量只有一份（消费方传的是 `KATEX_ERROR_COLOR`，不是自己写的颜色）
    expect(filesContaining("#cc0000")).toEqual([SHARED_MODULE]);
    expect(forkedUsages("errorColor", "KATEX_ERROR_COLOR")).toEqual([]);
    expect(forkedUsages("singleDollarTextMath", "KATEX_SINGLE_DOLLAR_TEXT_MATH")).toEqual([]);
  });

  // KaTeX 本体不得被 eager 模块静态引入：barrel / 消息组件都必须走动态导入（2026-10-15 实测过静态可达）
  test("聊天链路经动态导入到达 KaTeX", () => {
    const message = readFileSync(join(WEB_ROOT, "chat/primitives/message.tsx"), "utf8");
    const plugins = readFileSync(join(WEB_ROOT, "chat/ui-spec/plugins.ts"), "utf8");
    const barrels = [
      readFileSync(join(WEB_ROOT, "index.ts"), "utf8"),
      readFileSync(join(WEB_ROOT, "chat/index.ts"), "utf8"),
    ];

    expect(stripComments(message)).toContain('import("../ui-spec/plugins")');
    expect(stripComments(message)).not.toMatch(/^import \{[^}]*UI_SPEC_PLUGINS/m);
    // barrel 不得转出插件常量（它含数学插件，静态转出会把 KaTeX 拉进入口 chunk）；
    // 注释里说明「为什么不再转出」是允许的，故先剥注释再断言
    for (const barrel of barrels) expect(stripComments(barrel)).not.toContain("UI_SPEC_PLUGINS");
    // 插件模块本身（惰性 chunk）里也不得有 `katex` 的静态值导入，KaTeX 只能经 `@streamdown/math` 与动态导入到达
    expect(plugins).not.toMatch(/^import .*from "katex/m);
    // 样式表触发点必须留着：聊天侧没有别的 `loadKatexStyles()` 调用，漏掉会让公式退回浏览器默认排版
    expect(stripComments(plugins)).toContain("loadKatexStyles()");
  });
});
