import { describe, expect, test } from "bun:test";
import { readNarrator } from "@/components/chat/narrators/read";
import type { NarrationContext } from "@/components/chat/narrators/types";
import type { ToolCallData } from "@/src/lib/types";

/**
 * readNarrator 单测。
 *
 * 覆盖：
 * - match 规则（含 "read" 关键字 / opencode 目录读取兜底）
 * - verb、文件名提取（object）
 * - 行号区间作为 detail（文件场景）
 * - 目录条目数作为 detail（opencode 目录场景）
 * - 字段兼容（file_path / path / filePath）
 */

// mockT：覆盖 read narrator 用到的所有 i18n key
// - common.lineRange：文件场景行号区间
// - read.entries：目录场景条目数
const mockT = ((key: string, opts?: Record<string, unknown>) => {
  if (key === "common.lineRange") return `第 ${opts?.range} 行`;
  if (key === "read.entries") return `${opts?.count} 个条目`;
  return key;
}) as unknown as NarrationContext["t"];

// 构造 NarrationContext，rawOutput 可选（目录场景才需要）
function makeCtx(
  rawInput: unknown,
  rawOutput?: unknown,
  kind: "read-file" | "read-directory" = "read-file",
): NarrationContext {
  return {
    tool: {
      id: "t1",
      title: "Read",
      status: "complete",
      rawInput: rawInput as Record<string, unknown>,
      ...(rawOutput !== undefined ? { rawOutput } : {}),
    } as ToolCallData,
    kind,
    status: "complete",
    t: mockT,
  };
}

// opencode read 工具读目录的典型 rawOutput（含 <path>/<type>/<entries> 标签 + metadata.preview）
const OPENCODE_DIR_OUTPUT = {
  output:
    "<path>/workspaces/env_xxx</path>\n<type>directory</type>\n<entries>\n.opencode/\nuser/\n\n(2 entries)\n</entries>",
  metadata: {
    preview: ".opencode/\nuser/",
    truncated: false,
    loaded: [],
  },
};

// opencode read 工具读文件的典型 rawOutput（<type>file</type>，无 entries）
const OPENCODE_FILE_OUTPUT = {
  output: "<path>/workspaces/env_xxx/foo.ts</path>\n<type>file</type>\nhello world",
};

describe("readNarrator", () => {
  // kinds 包含 read-file 和 read-directory
  test("kinds 包含 read-file 和 read-directory", () => {
    expect(readNarrator.kinds).toContain("read-file");
    expect(readNarrator.kinds).toContain("read-directory");
  });

  // 中文动词必须是"读取"
  test("verb 是 '读取'", () => {
    expect(readNarrator.verb).toBe("读取");
  });

  // 基本场景：从 file_path 提取文件名作为 object
  test("提取文件名（file_path）", () => {
    const { object, detail } = readNarrator.getDisplay(makeCtx({ file_path: "/a/b/c.ts" }));
    expect(object).toBe("c.ts");
    expect(detail).toBeUndefined();
  });

  // 有 offset+limit 时 object 仍是文件名，行号区间作为 detail
  test("offset+limit 转成行号区间作为 detail", () => {
    const { object, detail } = readNarrator.getDisplay(makeCtx({ file_path: "/a/b/c.ts", offset: 100, limit: 50 }));
    expect(object).toBe("c.ts");
    expect(detail).toBe("第 100-149 行");
  });

  // 无行号限制时 detail 不显示
  test("无 offset 时无 detail", () => {
    const { object, detail } = readNarrator.getDisplay(makeCtx({ file_path: "/x.ts" }));
    expect(object).toBe("x.ts");
    expect(detail).toBeUndefined();
  });

  // 兼容 path 字段（OpenCode 等其他 Agent 风格）
  test("兼容 path 字段", () => {
    const { object } = readNarrator.getDisplay(makeCtx({ path: "/y/z.ts" }));
    expect(object).toBe("z.ts");
  });

  // ===== opencode 目录读取场景 =====

  // 目录场景：getDisplay 提取末尾段为 object，detail 显示条目数
  test("目录场景下 detail 显示条目数（解析 metadata.preview）", () => {
    const tool = {
      ...makeCtx({ filePath: "/workspaces/env_xxx" }, OPENCODE_DIR_OUTPUT, "read-directory").tool,
      title: "workspaces/.../env_xxx",
    } as ToolCallData;
    const { object, detail } = readNarrator.getDisplay({ tool, kind: "read-directory", status: "complete", t: mockT });
    expect(object).toBe("env_xxx");
    expect(detail).toBe("2 个条目");
  });

  // 目录场景：metadata 缺失时回退到 <entries> 块解析
  test("目录场景下无 metadata 时从 <entries> 块解析条目数", () => {
    const rawOutput = {
      output: "<path>/x</path>\n<type>directory</type>\n<entries>\na\nb\nc\n\n(3 entries)\n</entries>",
    };
    const tool = {
      ...makeCtx({ filePath: "/x" }, rawOutput, "read-directory").tool,
      title: "/x",
    } as ToolCallData;
    const { detail } = readNarrator.getDisplay({ tool, kind: "read-directory", status: "complete", t: mockT });
    expect(detail).toBe("3 个条目");
  });

  // opencode 文件读取场景（<type>file</type>）：object 提取文件名，无条目数 detail
  test("文件场景（<type>file</type>）显示文件名且无条目数 detail", () => {
    const tool = {
      ...makeCtx({ filePath: "/workspaces/env_xxx/foo.ts" }, OPENCODE_FILE_OUTPUT, "read-file").tool,
      title: "workspaces/.../foo.ts",
    } as ToolCallData;
    const { object, detail } = readNarrator.getDisplay({ tool, kind: "read-file", status: "complete", t: mockT });
    expect(object).toBe("foo.ts");
    expect(detail).toBeUndefined();
  });
});
