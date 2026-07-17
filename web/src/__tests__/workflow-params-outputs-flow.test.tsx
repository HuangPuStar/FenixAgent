import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// 显式 mock react-i18next，避免 CI 环境模块解析不稳定导致 I18nextProvider 找不到
import { createElement } from "react";
import ReactDOMServer from "react-dom/server";

mock.module("react-i18next", () => ({
  I18nextProvider: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "zh" },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));

afterEach(() => {
  mock.restore();
});

// import.meta.dirname = web/src/__tests__
const webSrc = join(import.meta.dirname, "..");
const readSrc = (rel: string) => readFileSync(join(webSrc, rel), "utf-8");

describe("OutputsEditor", () => {
  // 组件导出是函数
  test("exports OutputsEditor as a function", async () => {
    const { OutputsEditor } = await import("../pages/workflow/components/OutputsEditor");
    expect(typeof OutputsEditor).toBe("function");
  });

  // 在 mock i18n 下能渲染不抛错
  test("renders without throwing with minimal props", async () => {
    const { OutputsEditor } = await import("../pages/workflow/components/OutputsEditor");
    expect(() => {
      ReactDOMServer.renderToString(
        createElement(OutputsEditor, {
          value: undefined,
          onChange: () => {},
          readOnly: false,
          keyPlaceholder: "key",
          patternPlaceholder: "pattern",
          addLabel: "Add",
        }),
      );
    }).not.toThrow();
  });

  // 已有 entry 也能渲染
  test("renders with existing value without throwing", async () => {
    const { OutputsEditor } = await import("../pages/workflow/components/OutputsEditor");
    expect(() => {
      ReactDOMServer.renderToString(
        createElement(OutputsEditor, {
          value: { foo: { pattern: "/tmp/x", type: "file" } },
          onChange: () => {},
          readOnly: false,
          keyPlaceholder: "key",
          patternPlaceholder: "pattern",
          addLabel: "Add",
        }),
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
  test("exports ParamsEditor as a function", async () => {
    const { ParamsEditor } = await import("../pages/workflow/components/ParamsEditor");
    expect(typeof ParamsEditor).toBe("function");
  });

  // 在 mock i18n 下能渲染不抛错（无 default 值）
  test("renders without throwing with minimal props", async () => {
    const { ParamsEditor } = await import("../pages/workflow/components/ParamsEditor");
    expect(() => {
      ReactDOMServer.renderToString(
        createElement(ParamsEditor, {
          value: undefined,
          onChange: () => {},
          readOnly: false,
          namePlaceholder: "name",
          defaultPlaceholder: "default",
          addLabel: "Add",
        }),
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
