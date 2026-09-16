import { describe, expect, test } from "bun:test";
import { getFileCategory } from "../../components/knowledge/ResourcePreviewContent";

describe("ResourcePreviewContent 文件预览分类纯逻辑", () => {
  // PDF 应走独立的文档预览路径。
  test("PDF 文件分类为 pdf", () => {
    expect(getFileCategory("quarterly-report.pdf")).toBe("pdf");
  });

  // 扩展名大小写不应改变图片预览类型。
  test("大写 JPEG 文件分类为 image", () => {
    expect(getFileCategory("camera-shot.JPEG")).toBe("image");
  });

  // SVG 也应作为浏览器可直接显示的图片处理。
  test("SVG 文件分类为 image", () => {
    expect(getFileCategory("architecture.svg")).toBe("image");
  });

  // markdown 别名应复用 Markdown 内容加载和格式化路径。
  test("markdown 扩展名分类为 markdown", () => {
    expect(getFileCategory("release-notes.markdown")).toBe("markdown");
  });

  // HTM 兼容扩展名应走 HTML 内容预览。
  test("HTM 文件分类为 html", () => {
    expect(getFileCategory("legacy-page.htm")).toBe("html");
  });

  // Matroska 视频应保留在视频预览分支。
  test("MKV 文件分类为 video", () => {
    expect(getFileCategory("recording.mkv")).toBe("video");
  });

  // M4V 是视频分支支持的另一种容器格式。
  test("M4V 文件分类为 video", () => {
    expect(getFileCategory("trailer.m4v")).toBe("video");
  });

  // 宏启用工作簿仍应使用前端表格解析。
  test("XLSM 文件分类为 spreadsheet", () => {
    expect(getFileCategory("forecast.xlsm")).toBe("spreadsheet");
  });

  // CSV 不能误入 Office 的 PDF 转换降级流程。
  test("CSV 文件分类为 spreadsheet", () => {
    expect(getFileCategory("inventory.csv")).toBe("spreadsheet");
  });

  // TypeScript React 源码应作为可读取文本加载。
  test("TSX 文件分类为 text", () => {
    expect(getFileCategory("dashboard.tsx")).toBe("text");
  });

  // 环境配置扩展名应作为普通文本而非未知二进制文件处理。
  test("ENV 文件分类为 text", () => {
    expect(getFileCategory("production.env")).toBe("text");
  });

  // 旧版 Word 文档应进入 Office 预览策略。
  test("DOC 文件分类为 office", () => {
    expect(getFileCategory("contract.doc")).toBe("office");
  });

  // 多级扩展名按最后一个扩展名决定预览类型。
  test("压缩文件分类为 other", () => {
    expect(getFileCategory("database.backup.tar.gz")).toBe("other");
  });

  // 没有扩展名时不能假定存在可预览格式。
  test("无扩展名文件分类为 other", () => {
    expect(getFileCategory("NOTICE")).toBe("other");
  });

  // 路径中的点号不应干扰末尾文件扩展名识别。
  test("带路径的 PDF 文件分类为 pdf", () => {
    expect(getFileCategory("exports/v1.2/final.PDF")).toBe("pdf");
  });

  // 以点结尾没有有效扩展名时应安全降级。
  test("点号结尾的文件分类为 other", () => {
    expect(getFileCategory("unfinished.")).toBe("other");
  });

  // 点文件名称本身不是受支持的扩展名时应保留未知类型。
  test("点文件分类为 other", () => {
    expect(getFileCategory(".editorconfig")).toBe("other");
  });
});
