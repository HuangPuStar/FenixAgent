import { afterEach, describe, expect, mock, test } from "bun:test";
import ReactDOMServer from "react-dom/server";

// 显式 mock react-i18next，避免其他测试文件的 mock.module 残留影响 SSR 渲染
/**
 * `react-i18next` 替身的跨包并集出口：`useTranslation` 由本文件自带翻译表，
 * 其余出口给同签名直通版本——bun 1.4.2 下 `mock.module` 的命名空间会被同进程后续文件复用，
 * 缺少 `I18nextProvider` 会让之后加载的组件（如 identity 的弹窗）在渲染期直接抛错。
 */
const REACT_I18NEXT_UNION = {
  I18nextProvider: ({ children }: { children?: unknown }) => children,
  initReactI18next: { type: "3rdParty", init: () => {} },
  Trans: ({ children }: { children?: unknown }) => children,
};

mock.module("react-i18next", () => ({
  ...REACT_I18NEXT_UNION,
  I18nextProvider: ({ children }: { children: unknown }) => children,
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

afterEach(() => {
  mock.restore();
});

describe("FilePickerPanel", () => {
  test("exports FilePickerPanel as a function", async () => {
    const mod = await import("../components/chat/FilePickerPanel");
    expect(typeof mod.FilePickerPanel).toBe("function");
  });

  test("renders without throwing with required props", async () => {
    const { FilePickerPanel } = await import("../components/chat/FilePickerPanel");
    expect(() => {
      ReactDOMServer.renderToString(<FilePickerPanel envId="env_test" onSelect={() => {}} onClose={() => {}} />);
    }).not.toThrow();
  });

  test("renders search input placeholder", async () => {
    const { FilePickerPanel } = await import("../components/chat/FilePickerPanel");
    const html = ReactDOMServer.renderToString(
      <FilePickerPanel envId="env_test" onSelect={() => {}} onClose={() => {}} />,
    );
    // SSR 下 i18n 未初始化返回 key
    expect(html).toContain("filePicker.searchPlaceholder");
  });

  test("renders upload button icon", async () => {
    const { FilePickerPanel } = await import("../components/chat/FilePickerPanel");
    const html = ReactDOMServer.renderToString(
      <FilePickerPanel envId="env_test" onSelect={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain("lucide-upload");
  });

  test("renders className when provided", async () => {
    const { FilePickerPanel } = await import("../components/chat/FilePickerPanel");
    const html = ReactDOMServer.renderToString(
      <FilePickerPanel envId="env_test" onSelect={() => {}} onClose={() => {}} className="custom-panel" />,
    );
    expect(html).toContain("custom-panel");
  });
});
