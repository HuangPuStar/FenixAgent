import { describe, expect, test } from "bun:test";
import ReactDOMServer from "react-dom/server";

describe("FilePickerPanel", () => {
  test("exports FilePickerPanel as a function", async () => {
    const mod = await import("../../components/chat/FilePickerPanel");
    expect(typeof mod.FilePickerPanel).toBe("function");
  });

  test("renders without throwing with required props", async () => {
    const { FilePickerPanel } = await import("../../components/chat/FilePickerPanel");
    expect(() => {
      ReactDOMServer.renderToString(<FilePickerPanel envId="env_test" onSelect={() => {}} onClose={() => {}} />);
    }).not.toThrow();
  });

  test("renders search input placeholder", async () => {
    const { FilePickerPanel } = await import("../../components/chat/FilePickerPanel");
    const html = ReactDOMServer.renderToString(
      <FilePickerPanel envId="env_test" onSelect={() => {}} onClose={() => {}} />,
    );
    // SSR 下 i18n 未初始化返回 key
    expect(html).toContain("filePicker.searchPlaceholder");
  });

  test("renders upload button icon", async () => {
    const { FilePickerPanel } = await import("../../components/chat/FilePickerPanel");
    const html = ReactDOMServer.renderToString(
      <FilePickerPanel envId="env_test" onSelect={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain("lucide-upload");
  });

  test("renders className when provided", async () => {
    const { FilePickerPanel } = await import("../../components/chat/FilePickerPanel");
    const html = ReactDOMServer.renderToString(
      <FilePickerPanel envId="env_test" onSelect={() => {}} onClose={() => {}} className="custom-panel" />,
    );
    expect(html).toContain("custom-panel");
  });
});
