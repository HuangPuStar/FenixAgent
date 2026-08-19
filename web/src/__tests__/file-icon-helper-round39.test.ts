import { describe, expect, test } from "bun:test";

import { FileTypeIcon, getFileExtension } from "../components/file-icon-helper";

describe("文件图标辅助逻辑 Round 39", () => {
  // 常规扩展名应提取为小写，供预设映射查询。
  test("解析普通文件扩展名", () => {
    expect(getFileExtension("report.pdf")).toBe("pdf");
  });

  // 多点文件名只能使用最后一段作为扩展名。
  test("解析多点文件名的最后扩展名", () => {
    expect(getFileExtension("archive.backup.tar.gz")).toBe("gz");
  });

  // 大写扩展名应归一化，避免错过预设图标。
  test("将大写扩展名归一化", () => {
    expect(getFileExtension("PHOTO.JPEG")).toBe("jpeg");
  });

  // 路径目录中的点号不能影响末尾文件的扩展名。
  test("保留路径末尾文件的扩展名", () => {
    expect(getFileExtension("releases/v1.2/readme.MD")).toBe("md");
  });

  // 无点号文件名没有可用于图标映射的扩展名。
  test("无点号文件返回空扩展名", () => {
    expect(getFileExtension("LICENSE")).toBe("");
  });

  // 尾随点号没有实际扩展名内容。
  test("尾随点号返回空扩展名", () => {
    expect(getFileExtension("draft.")).toBe("");
  });

  // 隐藏文件的首点后内容仍会作为扩展名参与映射。
  test("将隐藏文件名内容视为扩展名", () => {
    expect(getFileExtension(".gitignore")).toBe("gitignore");
  });

  // 单独点号不能产生空白映射键。
  test("单独点号返回空扩展名", () => {
    expect(getFileExtension(".")).toBe("");
  });

  // 已配置的 JavaScript 文件应使用预设代码图标样式。
  test("为 JavaScript 使用预设代码图标", () => {
    expect(FileTypeIcon({ filename: "app.js" }).props).toMatchObject({
      extension: "js",
      color: "#F5F0C3",
      foldColor: "#E8E0A8",
      type: "code",
    });
  });

  // TSX 有独立的折角颜色，不能退化成 ts 配置。
  test("为 TSX 保留专属折角颜色", () => {
    expect(FileTypeIcon({ filename: "Widget.TSX" }).props).toMatchObject({
      extension: "tsx",
      color: "#B8D4E0",
      foldColor: "#98B8C8",
      type: "code",
    });
  });

  // SVG 使用 vector glyph，而非通用代码 glyph。
  test("为 SVG 使用矢量图标类型", () => {
    expect(FileTypeIcon({ filename: "logo.svg" }).props).toMatchObject({
      extension: "svg",
      color: "#F5D8B0",
      type: "vector",
    });
  });

  // INI 预设为 settings glyph。
  test("为 INI 使用设置图标类型", () => {
    expect(FileTypeIcon({ filename: "settings.ini" }).props).toMatchObject({
      extension: "ini",
      color: "#C8C8C8",
      type: "settings",
    });
  });

  // PDF 有专用 acrobat glyph 和折角颜色。
  test("为 PDF 使用 Acrobat 图标类型", () => {
    expect(FileTypeIcon({ filename: "contract.pdf" }).props).toMatchObject({
      extension: "pdf",
      color: "#E8C0C0",
      foldColor: "#D0A0A0",
      type: "acrobat",
    });
  });

  // 表格文档应使用 spreadsheet glyph。
  test("为 XLSX 使用表格图标类型", () => {
    expect(FileTypeIcon({ filename: "budget.xlsx" }).props).toMatchObject({
      extension: "xlsx",
      color: "#B8D8C8",
      type: "spreadsheet",
    });
  });

  // 演示文稿应使用 presentation glyph。
  test("为 PPTX 使用演示图标类型", () => {
    expect(FileTypeIcon({ filename: "roadmap.pptx" }).props).toMatchObject({
      extension: "pptx",
      color: "#F0C8B8",
      type: "presentation",
    });
  });

  // 字体文件应使用 font glyph。
  test("为 WOFF2 使用字体图标类型", () => {
    expect(FileTypeIcon({ filename: "brand.woff2" }).props).toMatchObject({
      extension: "woff2",
      color: "#EAD7C0",
      type: "font",
    });
  });

  // 已配置图片格式应保持 image glyph。
  test("为 WEBP 使用图片图标类型", () => {
    expect(FileTypeIcon({ filename: "preview.webp" }).props).toMatchObject({
      extension: "webp",
      color: "#B8E0C8",
      type: "image",
    });
  });

  // 已配置音频格式应保持 audio glyph。
  test("为 FLAC 使用音频图标类型", () => {
    expect(FileTypeIcon({ filename: "song.flac" }).props).toMatchObject({
      extension: "flac",
      color: "#E0BCB8",
      type: "audio",
    });
  });

  // 已配置视频格式应保持 video glyph。
  test("为 WEBM 使用视频图标类型", () => {
    expect(FileTypeIcon({ filename: "demo.webm" }).props).toMatchObject({
      extension: "webm",
      color: "#E8C0C0",
      type: "video",
    });
  });

  // 已配置压缩格式应保持 compressed glyph。
  test("为 7z 使用压缩图标类型", () => {
    expect(FileTypeIcon({ filename: "bundle.7z" }).props).toMatchObject({
      extension: "7z",
      color: "#F0E4B0",
      type: "compressed",
    });
  });

  // 无扩展名应直接走默认文档图标分支。
  test("无扩展名使用默认文档图标", () => {
    expect(FileTypeIcon({ filename: "NOTICE" }).props).toEqual({
      color: "#78909C",
      type: "document",
    });
  });

  // 未预设但可推断的代码扩展名应由猜测逻辑标记为 code。
  test("为未知 GraphQL 扩展名推断代码类型", () => {
    expect(FileTypeIcon({ filename: "schema.graphql" }).props).toMatchObject({
      extension: "graphql",
      type: "code",
    });
  });

  // 未预设但可推断的图片扩展名应由猜测逻辑标记为 image。
  test("为未知 TIFF 扩展名推断图片类型", () => {
    expect(FileTypeIcon({ filename: "scan.tiff" }).props).toMatchObject({
      extension: "tiff",
      type: "image",
    });
  });

  // 未预设但可推断的压缩扩展名应由猜测逻辑标记为 compressed。
  test("为未知 TGZ 扩展名推断压缩类型", () => {
    expect(FileTypeIcon({ filename: "source.tgz" }).props).toMatchObject({
      extension: "tgz",
      type: "compressed",
    });
  });

  // 完全未知扩展名仍应生成稳定的调色板颜色且不虚构 glyph 类型。
  test("为完全未知扩展名保留哈希颜色和空类型", () => {
    const icon = FileTypeIcon({ filename: "artifact.unmappedformat" });

    expect(icon.props).toMatchObject({ extension: "unmappedformat", type: undefined });
    expect(icon.props.color).toMatch(/^#[0-9A-F]{6}$/);
  });
});
