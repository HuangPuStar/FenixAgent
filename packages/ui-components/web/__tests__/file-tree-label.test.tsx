import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import type { ParsedFileNode } from "../components/file-tree-model";
import { FileTreeLabel, FileTreeTooltip } from "../components/internal/file-tree-label";
import zh from "../i18n/locales/zh/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const i18n = createInstance();
await i18n.init({ lng: "zh-CN", fallbackLng: "zh", initAsync: false, resources: { zh: { [UI_COMPONENTS_NS]: zh } } });
const now = Date.parse("2026-11-17T14:34:00Z");

/** 渲染真实文件标签，验证用户可读信息与读屏文案。 */
function render(node: Partial<ParsedFileNode> = {}): string {
  const file = { name: "empty.txt", path: "user/empty.txt", isDir: false, children: [], ...node };
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <FileTreeTooltip node={file}>
        <div role="treeitem" tabIndex={-1}>
          <FileTreeLabel now={now} node={file} />
        </div>
      </FileTreeTooltip>
    </I18nextProvider>,
  );
}

describe("文件树标签", () => {
  // 空文件仍有大小与可读的修改时间，读屏文案提供精确字节和完整时间。
  test("文件行显示零字节与修改时间", () => {
    const markup = render({ size: 0, modifiedAt: now - 120000 });
    expect(markup).toContain("0 B");
    expect(markup).toContain("2分钟前");
    expect(markup).toContain("0 字节");
    expect(markup).toContain("修改时间");
  });

  // 旧机器端缺失元数据时必须明确未知，不伪装为 0 B 或刚修改。
  test("缺失字段显示未知且目录不显示文件元数据", () => {
    const markup = render();
    expect(markup).toContain("—");
    expect(markup).not.toContain("0 B");
    expect(render({ isDir: true })).not.toContain("—");
  });
});
