// LabeledField（`config/LabeledField`）的契约测试：隐式 label 关联、提示的位置、根节点透传。
//
// 为什么用服务端渲染：本组件是纯展示件（无状态、无 i18n、无 Portal），标记即契约——不需要 happy-dom
// 与交互模拟，断言的取值来源就是渲染出的 HTML。
//
// 两条断言是这次下沉的重点：① `<label>` 必须**包裹**控件（隐式关联），否则「不生成 id」就会退化成
// 「控件没有可访问名」；② 提示必须落在 `</label>` **之后**，否则它会被算进控件的可访问名。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LabeledField } from "../config/LabeledField";

/** 渲染一个字段，返回标记；`props` 省略标签与提示，只留控件。 */
function render(props: Partial<Parameters<typeof LabeledField>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(LabeledField, { label: "名称", ...props }, createElement("input", { type: "text" })),
  );
}

describe("LabeledField", () => {
  test("字段名渲染在 label 内，且 label 包裹控件（隐式关联）", () => {
    const markup = render();

    // `<label ...><span ...>名称</span><input .../></label>`：控件是 label 的后代，关联由结构保证。
    expect(markup).toContain('<label class="grid gap-1.5">');
    expect(markup).toContain(">名称</span>");
    expect(markup).toMatch(/<label[^>]*>.*<input[^>]*\/><\/label>/);
  });

  // 组件不生成 id，也不接收 htmlFor：接线靠隐式关联，所以不可能出现 id 重复或 htmlFor 失联。
  test("不生成 id / htmlFor", () => {
    expect(render()).not.toContain("id=");
    expect(render()).not.toContain('for="');
  });

  test("无提示时不渲染提示节点，有提示时渲染在控件下方且在 label 之外", () => {
    const withoutHint = render();

    expect(withoutHint).not.toContain("labeled-field-hint");

    const withHint = render({ hint: "空格分隔，含空格的参数用双引号包裹" });

    expect(withHint).toContain('data-slot="labeled-field-hint"');
    expect(withHint).toContain("空格分隔，含空格的参数用双引号包裹");
    // 提示在 `</label>` 之后：控件的可访问名只取 label 内的文字。
    expect(withHint.indexOf("</label>")).toBeLessThan(withHint.indexOf("labeled-field-hint"));
  });

  test("className 合并进根元素，且不新增外边距", () => {
    const markup = render({ className: "sm:col-span-2" });

    expect(markup).toContain('data-slot="labeled-field" class="grid gap-1.5 sm:col-span-2"');
  });

  test("其余根节点属性透传", () => {
    const markup = render({ role: "group", "aria-label": "字段名" });

    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="字段名"');
  });

  // 库内组件不接 i18n：文案（含提示）全由调用方以已翻译的 string 传入，key 只留在调用方。
  test("组件自身不引 i18n", () => {
    const source = readFileSync(join(import.meta.dir, "..", "config/LabeledField.tsx"), "utf8");

    expect(source).not.toContain("react-i18next");
    expect(source).not.toContain("useTranslation");
  });

  // 命名避让：根 barrel 里 `ui/form.tsx` 已占用 FormField / FormItem / FormLabel / FormControl /
  // FormDescription / FormMessage，同名会在 `export *` 处撞名（TS2308）。
  test("不与 ui/form.tsx 的导出同名", async () => {
    const form = await import("../ui/form");

    for (const name of Object.keys(form)) {
      expect(name).not.toBe("LabeledField");
    }
    expect(typeof LabeledField).toBe("function");
  });
});
