// LabeledField（`config/LabeledField`）的契约测试：隐式 label 关联、显式 label 关联、提示的位置、根节点透传。
//
// 为什么用服务端渲染：本组件是纯展示件（无状态、无 i18n、无 Portal），标记即契约——不需要 happy-dom
// 与交互模拟，断言的取值来源就是渲染出的 HTML。
//
// 两种关联各自的要害：① 隐式模式下 `<label>` 必须**包裹**控件，否则「不生成 id」就会退化成「控件没有
// 可访问名」；② 显式模式下 `<label>` 必须**不包裹** children，否则它会重新把复合控件里的按钮文案算进主
// 控件的可访问名；③ 两种模式下提示都必须落在 `</label>` **之后**，否则会被算进可访问名。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LabeledField } from "../config/LabeledField";

/** 渲染一个隐式关联字段（`<label>` 包裹单个控件）；`props` 省略标签与提示。 */
function render(props: Partial<Parameters<typeof LabeledField>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(LabeledField, { label: "名称", ...props }, createElement("input", { type: "text" })),
  );
}

/** 渲染一个显式关联字段（`htmlFor` + 控件 id，children 是「输入框 + 行内按钮」的复合控件）。 */
function renderExplicit(props: Partial<Parameters<typeof LabeledField>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(
      LabeledField,
      { label: "执行时间", htmlFor: "field-cron", ...props },
      createElement("input", { id: "field-cron", type: "text" }),
      createElement("button", { type: "button" }, "每 5 分钟"),
    ),
  );
}

describe("LabeledField", () => {
  describe("隐式关联（不传 htmlFor）", () => {
    test("字段名渲染在 label 内，且 label 包裹控件", () => {
      const markup = render();

      // `<label ...><span ...>名称</span><input .../></label>`：控件是 label 的后代，关联由结构保证。
      expect(markup).toContain('<label class="grid gap-1.5">');
      expect(markup).toContain(">名称</span>");
      expect(markup).toMatch(/<label[^>]*>.*<input[^>]*\/><\/label>/);
    });

    // 隐式模式不生成 id，也不渲染 for：接线靠包裹，所以不可能出现 id 重复或 htmlFor 失联。
    test("不生成 id / for", () => {
      expect(render()).not.toContain("id=");
      expect(render()).not.toContain('for="');
    });
  });

  describe("显式关联（传 htmlFor）", () => {
    test("渲染独立的 label（带 for），children 不再被 label 包裹", () => {
      const markup = renderExplicit();

      expect(markup).toContain('for="field-cron"');
      expect(markup).toContain(">执行时间</label>");
      // 复合控件整体落在 `</label>` 之后：label 里只剩字段名，按钮文案进不了输入框的可访问名。
      const labelEnd = markup.indexOf("</label>");
      expect(labelEnd).toBeLessThan(markup.indexOf('<input id="field-cron"'));
      expect(labelEnd).toBeLessThan(markup.indexOf("<button"));
    });

    test("字段名刻度与隐式模式一致（同一串类 + 同一个间距刻度）", () => {
      const markup = renderExplicit();

      expect(markup).toContain('class="text-sm font-medium text-text-primary"');
      expect(render()).toContain('class="text-sm font-medium text-text-primary"');
      expect(markup).toContain('data-slot="labeled-field" class="grid gap-1.5"');
    });

    test("提示渲染在 children 之后、label 之外", () => {
      const markup = renderExplicit({ hint: "留空使用默认时区", className: "sm:col-span-2" });

      expect(markup).toContain('data-slot="labeled-field" class="grid gap-1.5 sm:col-span-2"');
      expect(markup.indexOf("</label>")).toBeLessThan(markup.indexOf("labeled-field-hint"));
      expect(markup.indexOf("</button>")).toBeLessThan(markup.indexOf("labeled-field-hint"));
      expect(markup).toContain("留空使用默认时区");
    });
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
