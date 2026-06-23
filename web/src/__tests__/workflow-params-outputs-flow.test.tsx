import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import ReactDOMServer from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { OutputsEditor } from "../pages/workflow/components/OutputsEditor";
import { ParamsEditor } from "../pages/workflow/components/ParamsEditor";

// import.meta.dirname = web/src/__tests__
const webSrc = join(import.meta.dirname, "..");
const readSrc = (rel: string) => readFileSync(join(webSrc, rel), "utf-8");

// 用动态 import 避免 i18n 模块级副作用阻塞测试加载
const i18nPromise = import("../i18n");

describe("OutputsEditor", () => {
  // 组件导出是函数
  test("exports OutputsEditor as a function", () => {
    expect(typeof OutputsEditor).toBe("function");
  });

  // 在 i18n provider 下能渲染不抛错
  test("renders without throwing with minimal props", async () => {
    const { default: i18n } = await i18nPromise;
    expect(() => {
      ReactDOMServer.renderToString(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(OutputsEditor, {
            value: undefined,
            onChange: () => {},
            readOnly: false,
            keyPlaceholder: "key",
            patternPlaceholder: "pattern",
            addLabel: "Add",
          }),
        ),
      );
    }).not.toThrow();
  });

  // 已有 entry 也能渲染
  test("renders with existing value without throwing", async () => {
    const { default: i18n } = await i18nPromise;
    expect(() => {
      ReactDOMServer.renderToString(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(OutputsEditor, {
            value: { foo: { pattern: "/tmp/x", type: "file" } },
            onChange: () => {},
            readOnly: false,
            keyPlaceholder: "key",
            patternPlaceholder: "pattern",
            addLabel: "Add",
          }),
        ),
      );
    }).not.toThrow();
  });

  // 源码包含 onChange 调用与 add 按钮触发逻辑
  test("source wires onChange and add button", () => {
    const src = readSrc("pages/workflow/components/OutputsEditor.tsx");
    expect(src).toContain("onChange");
    expect(src).toContain("addLabel");
    expect(src).toContain("patternPlaceholder");
    // type 切换通过 select，至少应包含 type="file" / "dir" / "file-list" 之一
    expect(src).toMatch(/file-list|"file"|'file'/);
  });
});

describe("ParamsEditor", () => {
  // 组件导出是函数
  test("exports ParamsEditor as a function", () => {
    expect(typeof ParamsEditor).toBe("function");
  });

  // 在 i18n provider 下能渲染不抛错（无 default 值）
  test("renders without throwing with minimal props", async () => {
    const { default: i18n } = await i18nPromise;
    expect(() => {
      ReactDOMServer.renderToString(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(ParamsEditor, {
            value: undefined,
            onChange: () => {},
            readOnly: false,
            namePlaceholder: "name",
            defaultPlaceholder: "default",
            addLabel: "Add",
          }),
        ),
      );
    }).not.toThrow();
  });

  // type=boolean 时 default 渲染为 shadcn Checkbox 组件
  test("source renders Checkbox for boolean type", () => {
    const src = readSrc("pages/workflow/components/ParamsEditor.tsx");
    expect(src).toContain("<Checkbox");
    // type=number 时 default 应切换为 number input
    expect(src).toMatch(/type.*number|"number"|'number'/);
  });

  // 源码用 t() 走 i18n
  test("source uses i18n via useTranslation", () => {
    const src = readSrc("pages/workflow/components/ParamsEditor.tsx");
    expect(src).toContain("useTranslation");
  });
});

describe("NodeConfigCard start node branch", () => {
  // start 节点点开应渲染 WorkflowMetaCard
  test("NodeConfigCard renders WorkflowMetaCard for start node", () => {
    const src = readSrc("pages/workflow/components/NodeConfigCard.tsx");
    expect(src).toContain("WorkflowMetaCard");
    expect(src).toMatch(/isStartNode|START_NODE_ID/);
  });
});
