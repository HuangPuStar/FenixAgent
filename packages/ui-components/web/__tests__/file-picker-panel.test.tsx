// FilePickerPanel 的渲染测试（CE 阶段 2 §1.6 T6c1 从
// `packages/agent-runtime/web/__tests__/file-picker-panel.test.tsx` 迁入包内）。
//
// 迁移改动：
// - 组件改从包内 `../chat/shell/FilePickerPanel` 导入；
// - i18n 从「显式 mock `react-i18next` 让 `t()` 回显 key」换成包内 `createInstance` +
//   `../i18n/locales/en/uiComponents.json`，文案 key 前缀由 `filePicker.*` 变为 `chat.components.filePicker.*`；
// - 纯化后 `envId` prop 与 `fsApi` / `uploadChatFiles` 直连一并去掉，改为 `listDir` / `uploadFiles`
//   两个注入回调（宿主在回调里闭包环境 ID），用例按新契约传空实现即可，不再需要宿主侧的桩；
// - 全部用例只走 `react-dom/server`，不涉及 DOM 交互，因此不引入 happy-dom 引导。
// 文案断言取包内英文字典的译文，字典缺失时回落 key，两种状态下都能发现回归。

import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import ReactDOMServer from "react-dom/server";
import { initReactI18next } from "react-i18next/initReactI18next";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});

/** 读包内英文字典的 chat 子树；字典尚未搬运或键缺失时回落 key（`chat.` + path）。 */
function chatText(path: string): string {
  let current: unknown = (en as Record<string, unknown>).chat;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return `chat.${path}`;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : `chat.${path}`;
}

describe("FilePickerPanel", () => {
  // 面板必须以命名导出暴露组件本身，供宿主在附件选择入口直接挂载
  test("exports FilePickerPanel as a function", async () => {
    const mod = await import("../chat/shell/FilePickerPanel");
    expect(typeof mod.FilePickerPanel).toBe("function");
  });

  // 只给必需回调（列目录 / 上传 / 选中 / 关闭）就必须能渲染完，避免宿主少传可选 prop 时整页崩溃
  test("renders without throwing with required props", async () => {
    const { FilePickerPanel } = await import("../chat/shell/FilePickerPanel");
    expect(() => {
      ReactDOMServer.renderToString(
        <FilePickerPanel
          listDir={async () => ({ entries: [] })}
          uploadFiles={async () => ({ files: [] })}
          onSelect={() => {}}
          onClose={() => {}}
        />,
      );
    }).not.toThrow();
  });

  // 搜索框占位文案是用户定位文件的主要提示，缺失会让面板看起来只有裸输入框
  test("renders search input placeholder", async () => {
    const { FilePickerPanel } = await import("../chat/shell/FilePickerPanel");
    const html = ReactDOMServer.renderToString(
      <FilePickerPanel
        listDir={async () => ({ entries: [] })}
        uploadFiles={async () => ({ files: [] })}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain(chatText("components.filePicker.searchPlaceholder"));
  });

  // 上传入口只以图标呈现，图标缺失时用户无法发现「上传新文件」这条路径
  test("renders upload button icon", async () => {
    const { FilePickerPanel } = await import("../chat/shell/FilePickerPanel");
    const html = ReactDOMServer.renderToString(
      <FilePickerPanel
        listDir={async () => ({ entries: [] })}
        uploadFiles={async () => ({ files: [] })}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("lucide-upload");
  });

  // 宿主传入的 className 必须落到面板根节点上，否则宿主无法控制面板在弹层里的尺寸与定位
  test("renders className when provided", async () => {
    const { FilePickerPanel } = await import("../chat/shell/FilePickerPanel");
    const html = ReactDOMServer.renderToString(
      <FilePickerPanel
        listDir={async () => ({ entries: [] })}
        uploadFiles={async () => ({ files: [] })}
        onSelect={() => {}}
        onClose={() => {}}
        className="custom-panel"
      />,
    );
    expect(html).toContain("custom-panel");
  });
});
