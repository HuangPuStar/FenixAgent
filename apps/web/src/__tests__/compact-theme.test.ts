import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compile } from "tailwindcss";

const host = readFileSync(resolve(import.meta.dir, "../index.css"), "utf8");
const shared = readFileSync(
  resolve(import.meta.dir, "../../../../packages/ui-components/web/styles/theme.css"),
  "utf8",
);
const themes = (source: string) => source.match(/@theme(?: static)? \{[\s\S]*?\n\}/g)?.join("\n") ?? "";
const compactTheme = themes(host);
// 仅去掉本批间距覆盖，得到相同字体、公共基尺和尺寸指标下的对照组。
const baselineTheme = compactTheme.replace(/ {2}--(?:padding|margin|gap|min-height)-[\w\\.]+: [^;]+;\n/g, "");

async function utilities(theme: string, candidates: string[]) {
  const compiler = await compile(`${theme}\n@tailwind utilities;`);
  return compiler.build(candidates);
}

function rule(css: string, selector: string) {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("\n}", start) + 2);
}

describe("全站紧凑标尺", () => {
  test("宿主与包入口的 theme 保持一致", () => {
    expect(compactTheme).not.toBe("");
    expect(compactTheme).toBe(themes(shared));
    expect(compactTheme).toContain("--spacing: 4px;");
    expect(compactTheme).not.toMatch(/--(?:spacing-|height-|width-|size-|inset-)/);
  });

  test("标准间距类读取专属标尺，包含小数档、负值及悬停变体", async () => {
    const css = await utilities(compactTheme, [
      "p-2",
      "p-2.5",
      "px-4",
      "py-5.75",
      "px-6",
      "gap-2.5",
      "gap-y-1",
      "mb-4",
      "-mt-4",
      "hover:p-4",
    ]);
    expect(rule(css, ".p-2")).toContain("padding: var(--padding-2)");
    expect(rule(css, ".p-2\\.5")).toContain("padding: var(--padding-2\\.5)");
    expect(rule(css, ".py-5\\.75")).toContain("padding-block: var(--padding-5\\.75)");
    expect(rule(css, ".px-6")).toContain("padding-inline: var(--padding-6)");
    expect(rule(css, ".gap-2\\.5")).toContain("gap: var(--gap-2\\.5)");
    expect(rule(css, ".gap-y-1")).toContain("row-gap: var(--gap-1)");
    expect(rule(css, ".mb-4")).toContain("margin-bottom: var(--margin-4)");
    expect(rule(css, ".-mt-4")).toContain("calc(var(--margin-4) * -1)");
    expect(css).toContain("--padding-2: 6px");
    expect(css).toContain("--padding-2\\.5: 8px");
    expect(css).toContain("--padding-4: 12px");
    expect(css).toContain("--padding-5\\.75: 18px");
    expect(css).toContain("--padding-6: 18px");
    expect(css).toContain("--gap-2\\.5: 8px");
    expect(css).toContain("--gap-1: 3px");
    expect(css).toContain("--margin-4: 12px");
    expect(css).toContain(".hover\\:p-4");
  });

  test("图标、控件尺寸、侧栏宽度、偏移、圆角与全部字号的产出不变", async () => {
    const candidates = [
      "h-8",
      "h-9",
      "h-10",
      "h-8.5",
      "h-15",
      "min-h-8",
      "min-h-10",
      "max-h-15",
      "w-9",
      "w-12",
      "w-16",
      "w-60",
      "w-full",
      "min-w-60",
      "max-w-25",
      "size-4",
      "size-4.5",
      "size-6",
      "size-8",
      "size-9",
      "size-10",
      "inset-4",
      "top-6",
      "-right-3",
      "translate-x-4",
      "mx-2",
      "my-px",
      "py-1.5",
      "rounded",
      "rounded-md",
      "rounded-lg",
      "leading-4",
      "leading-5",
      "space-y-4",
      ...Array.from(compactTheme.matchAll(/--text-([\w]+):/g), ([, key]) => `text-${key}`),
    ];
    // 未消费的覆盖 token 会被 Tailwind 裁剪，因此可以逐字比较完整编译结果。
    expect(await utilities(compactTheme, candidates)).toBe(await utilities(baselineTheme, candidates));
  });

  test("目录下限跟随内容，不改组件类串或图标列宽", async () => {
    const css = await utilities(compactTheme, ["min-h-15", "h-15", "p-2.5", "leading-5", "leading-4", "mt-1"]);
    expect(rule(css, ".min-h-15")).toContain("min-height: var(--min-height-15)");
    expect(css).toContain("--min-height-15: 56px");
    expect(rule(css, ".h-15")).toContain("height: calc(var(--spacing) * 15)");
    // 两行文字 20 + 16，加 mt-1 的 4px 和上下各 8px；大于图标盒的 34px。
    expect(20 + 16 + 4 + 2 * 8).toBe(56);
    const catalog = readFileSync(
      resolve(import.meta.dir, "../../../../packages/ui-components/web/components/agent-catalog-index.tsx"),
      "utf8",
    );
    expect(catalog).toContain("min-h-15 min-w-0");
    expect(catalog).toContain("h-8.5");
    expect(catalog).toContain("calc(var(--spacing)*8.5)");
    expect(catalog).toContain("truncate text-sm leading-5");
    expect(catalog).toContain("mt-1 truncate text-xs leading-4");
  });
});
