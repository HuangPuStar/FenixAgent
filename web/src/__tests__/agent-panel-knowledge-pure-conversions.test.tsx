import { describe, expect, test } from "bun:test";
import {
  cardKindToStyle,
  isHindsightTool,
  kindLabel,
  simplifyToolName,
  supportsFilePreview,
  truncate,
} from "../../components/chat/tool-call-utils";
import { getFileCategory } from "../../components/knowledge/ResourcePreviewContent";
import {
  buildPreviewUrl,
  classifyFile,
  encodePathSegment,
  formatFileSize,
  getPreviewMimeType,
} from "../components/agent-panel/preview/utils";

describe("Agent panel 文件预览纯转换", () => {
  // 路径段编码必须保留 URL 的分层语义，并额外转义 encodeURIComponent 默认遗漏的括号。
  test("编码特殊路径段且预览 URL 逐段编码", () => {
    expect(encodePathSegment("报告 (最终).md")).toBe("%E6%8A%A5%E5%91%8A%20%28%E6%9C%80%E7%BB%88%29.md");
    expect(buildPreviewUrl("env 1", "目录/a b.ts")).toBe(
      "/web/environments/env 1/fs/%E7%9B%AE%E5%BD%95/a%20b.ts?preview=true",
    );
  });

  // 文件名大小写、点文件和分类优先级会影响对应预览器的选择，点文件没有扩展名时安全降级。
  test("按扩展名稳定分类并处理点文件", () => {
    expect(classifyFile("docs/README.MD")).toBe("markdown");
    expect(classifyFile("assets/logo.SVG")).toBe("image");
    expect(classifyFile("export/report.CSV")).toBe("table");
    expect(classifyFile("contract.docx")).toBe("office");
    expect(classifyFile(".gitignore")).toBe("binary");
    expect(classifyFile("archive.unknown")).toBe("binary");
  });

  // 仅文本预览应显式提供 MIME，二进制文件继续由响应内容类型决定。
  test("为文本类文件提供 MIME 并保留二进制默认处理", () => {
    expect(getPreviewMimeType("docs/guide.markdown")).toBe("text/markdown");
    expect(getPreviewMimeType("page.HTM")).toBe("text/html");
    expect(getPreviewMimeType("src/main.TS")).toBe("text/plain");
    expect(getPreviewMimeType("image.webp")).toBeUndefined();
  });

  // 显示大小在字节、KB 和 MB 边界必须使用稳定的单位与一位小数。
  test("按文件大小边界格式化", () => {
    expect(formatFileSize(1023)).toBe("1023 B");
    expect(formatFileSize(1024)).toBe("1.0 KB");
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
  });
});

describe("知识库资源预览分类", () => {
  // 知识库分类应覆盖各专用预览器，并对无扩展名文件安全降级。
  test("区分媒体、表格、Office、文本与未知资源", () => {
    expect(getFileCategory("manual.PDF")).toBe("pdf");
    expect(getFileCategory("recording.MKV")).toBe("video");
    expect(getFileCategory("data.XLSM")).toBe("spreadsheet");
    expect(getFileCategory("slides.pptx")).toBe("office");
    expect(getFileCategory("service.ts")).toBe("text");
    expect(getFileCategory("LICENSE")).toBe("other");
  });
});

describe("工具卡片展示纯转换", () => {
  // 已知 kind 必须映射到稳定文案和样式，未知 kind 保持安全的灰色降级样式。
  test("映射卡片文案、样式与文件预览权限", () => {
    expect(kindLabel("web-search")).toBe("Search");
    expect(kindLabel("unknown")).toBe("");
    expect(cardKindToStyle("bash").iconColor).toContain("emerald");
    expect(cardKindToStyle("unknown").cardBg).toContain("gray");
    expect(supportsFilePreview("read-file")).toBe(true);
    expect(supportsFilePreview("read-directory")).toBe(false);
  });

  // 旧协议标题解析需优先识别具体工具，未知标题则仅规范化首个 ASCII 单词。
  test("兼容旧工具标题并截断展示文本", () => {
    expect(simplifyToolName("MultiEdit_file")).toBe("MultiEdit");
    expect(simplifyToolName("shell command")).toBe("Bash");
    expect(simplifyToolName("custom-tool_v2")).toBe("Custom");
    expect(simplifyToolName("123")).toBe("123");
    expect(truncate("abcdef", 3)).toBe("abc…");
    expect(truncate("abc", 3)).toBe("abc");
  });

  // Hindsight 前缀仅在标题开头且大小写无关时过滤，避免误伤普通工具名。
  test("精确识别 Hindsight 工具", () => {
    expect(isHindsightTool("HINDSIGHT_search")).toBe(true);
    expect(isHindsightTool("tool_hindsight_search")).toBe(false);
  });
});
