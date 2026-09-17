import { describe, expect, test } from "bun:test";

const { getPreviewMimeType, loadByteAccuratePreviewSource, normalizeToUserPath, shouldLoadPreviewAsBlob } =
  await import("../components/agent-panel/preview/utils");

describe("getPreviewMimeType — 特殊文件名仍按扩展名识别", () => {
  // open-file-viewer 会把 # 当成 URL fragment，显式 MIME 可避免 #123.txt 被判定为未知格式
  test("# 开头的 txt 文件返回文本 MIME", () => {
    expect(getPreviewMimeType("user/#123.txt")).toBe("text/plain");
  });

  // 非文本文件不强行覆盖 MIME，继续由预览组件按扩展名和响应类型识别
  test("非文本文件不返回覆盖 MIME", () => {
    expect(getPreviewMimeType("user/image.png")).toBeUndefined();
  });
});

describe("文本预览源 — 保留响应的真实字节大小", () => {
  // 文本插件对 URL 会回退使用字符数；文本文件必须转为 Blob，让 size 保留 UTF-8 原始字节数
  test("UTF-8 中文文本使用 Blob 字节大小而非字符数", async () => {
    const content = "中".repeat(1000);
    const fetchPreview = async () => new Response(content, { headers: { "Content-Type": "text/plain" } });

    const source = await loadByteAccuratePreviewSource("/preview/chinese.txt", fetchPreview);

    expect(source).toBeInstanceOf(Blob);
    expect((source as Blob).size).toBe(3000);
    expect((source as Blob).size).not.toBe(content.length);
  });

  // UTF-16 响应必须保留 BOM 和双字节编码，避免解码后按 4 个字符显示为 4 B
  test("UTF-16 文本使用原始响应字节大小", async () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65, 0x4b, 0x6d, 0xd5, 0x8b]);
    const fetchPreview = async () => new Response(bytes, { headers: { "Content-Type": "text/plain" } });

    const source = await loadByteAccuratePreviewSource("/preview/utf16.txt", fetchPreview);

    expect(source).toBeInstanceOf(Blob);
    expect((source as Blob).size).toBe(bytes.byteLength);
  });

  // 仅文本类型改为 Blob；依赖原始 URL 的 PDF、HTML 和媒体预览保持现有加载链路
  test("只为文本预览加载 Blob", () => {
    expect(shouldLoadPreviewAsBlob("user/a.txt")).toBe(true);
    expect(shouldLoadPreviewAsBlob("user/a.md")).toBe(true);
    expect(shouldLoadPreviewAsBlob("user/a.html")).toBe(false);
    expect(shouldLoadPreviewAsBlob("user/a.pdf")).toBe(false);
  });
});

// =============================================================================
// normalizeToUserPath() — Agent 工具调用上报路径的规范化
// 设计要点：workspace 路径结构固定为 .../env_{envId}/<相对路径>，
// 用 env_*/ 分隔符切分即可提取 workspace 相对路径，不依赖 server 上下文。
// =============================================================================

describe("normalizeToUserPath — 纯相对路径保持不变", () => {
  // 纯相对路径：不加 user/ 前缀，agent 的 cwd 即 workspace 根
  test("纯相对路径保持原样", () => {
    expect(normalizeToUserPath("src/foo.ts")).toBe("src/foo.ts");
  });

  // 多层目录的相对路径
  test("多层相对路径保持原样", () => {
    expect(normalizeToUserPath("a/b/c/d.txt")).toBe("a/b/c/d.txt");
  });

  // 仅文件名
  test("仅文件名保持原样", () => {
    expect(normalizeToUserPath("README.md")).toBe("README.md");
  });
});

describe("normalizeToUserPath — 已带 user/ 前缀保持不变", () => {
  // 已带 user/ 前缀：直接返回
  test("已带 user/ 前缀的路径保持不变", () => {
    expect(normalizeToUserPath("user/src/foo.ts")).toBe("user/src/foo.ts");
  });

  // 完全等于 user/
  test("user/ 保持不变", () => {
    expect(normalizeToUserPath("user/")).toBe("user/");
  });

  // 完全等于 user（无尾斜杠）
  test("user 规范化为 user/", () => {
    expect(normalizeToUserPath("user")).toBe("user/");
  });
});

describe("normalizeToUserPath — 绝对路径用 env_*/ 切分", () => {
  // 标准 workspace 绝对路径（user/ 段）：切分出 user/ 相对路径
  test("workspace 内 user/ 下的绝对路径切分出 user/ 相对路径", () => {
    const abs = "/var/workspaces/org_a/usr_b/env_1abc23/user/src/foo.ts";
    expect(normalizeToUserPath(abs)).toBe("user/src/foo.ts");
  });

  // workspace 绝对路径不含 user/ 段（如 .git/config）：切分出根相对路径
  test("workspace 内非 user/ 段的绝对路径切分出根相对路径", () => {
    const abs = "/var/workspaces/org_a/usr_b/env_1abc23/.git/config";
    expect(normalizeToUserPath(abs)).toBe(".git/config");
  });

  // macOS 风格绝对路径同样按 env_*/ 切分
  test("macOS 风格 workspace 绝对路径切分", () => {
    const abs = "/Users/alice/workspaces/org_a/usr_b/env_deadbeef/user/x.txt";
    expect(normalizeToUserPath(abs)).toBe("user/x.txt");
  });

  // 远程风格绝对路径：只要保留 env_{envId}/ 结构就能切分
  test("远程风格绝对路径切分", () => {
    const abs = "/home/ops/workspaces/org/usr/env_feedface/user/y.txt";
    expect(normalizeToUserPath(abs)).toBe("user/y.txt");
  });

  // 绝对路径但不含 env_*/ 段：原样返回让 server 兜底
  test("绝对路径无 env_*/ 段原样返回", () => {
    const abs = "/etc/passwd";
    expect(normalizeToUserPath(abs)).toBe(abs);
  });
});

describe("normalizeToUserPath — 边界场景", () => {
  // 空路径兜底为 user/
  test("空字符串兜底为 user/", () => {
    expect(normalizeToUserPath("")).toBe("user/");
  });

  // 带尾斜杠的相对路径去除尾斜杠后保持原样
  test("带尾斜杠的相对路径去除尾斜杠后保持原样", () => {
    expect(normalizeToUserPath("src/")).toBe("src");
  });
});
