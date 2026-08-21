import { describe, expect, test } from "bun:test";
import {
  extractErrorMessage,
  extractFileName,
  extractLineRange,
  findFirstStringValue,
  formatElapsed,
  truncate,
} from "@/components/chat/narrators/helpers";

/**
 * narrators/helpers.ts 纯函数单测。
 *
 * 测试范围：6 个工具函数全覆盖。
 * 不使用 mock（纯函数），遵循前端测试规范（参考 config-helpers.test.ts）。
 */
describe("narrators/helpers", () => {
  describe("extractFileName", () => {
    // 从 file_path 字段提取文件名（带目录前缀只取最后一段）
    test("从 file_path 提取末段文件名", () => {
      expect(extractFileName({ file_path: "/a/b/c.ts" })).toBe("c.ts");
    });

    // 兼容 path 字段（OpenCode 等其他 Agent 风格）
    test("兼容 path 字段", () => {
      expect(extractFileName({ path: "/x/y.ts" })).toBe("y.ts");
    });

    // 兼容 filePath 字段（驼峰命名）
    test("兼容 filePath 字段", () => {
      expect(extractFileName({ filePath: "/z.ts" })).toBe("z.ts");
    });

    // 三种字段都缺失时返回兜底占位"文件"
    test("无路径字段返回文件占位", () => {
      expect(extractFileName({})).toBe("文件");
      expect(extractFileName(undefined)).toBe("文件");
    });

    // 纯文件名（无目录分隔符）原样返回
    test("无目录分隔符的文件名原样返回", () => {
      expect(extractFileName({ file_path: "README.md" })).toBe("README.md");
    });
  });

  describe("extractLineRange", () => {
    // offset+limit 风格（Claude Code），转换成闭区间
    test("offset+limit 转成行号闭区间", () => {
      expect(extractLineRange({ offset: 100, limit: 50 })).toBe("100-149");
    });

    // start_line+end_line 风格（其他 Agent），原样返回
    test("start_line+end_line 兼容", () => {
      expect(extractLineRange({ start_line: 10, end_line: 20 })).toBe("10-20");
    });

    // 没有行号限制相关字段时返回空串
    test("无行号字段返回空串", () => {
      expect(extractLineRange({})).toBe("");
      expect(extractLineRange(undefined)).toBe("");
    });

    // offset=0 / limit=0 视为无效（Number(0) falsy），返回空串
    test("offset 或 limit 为 0 视为无效", () => {
      expect(extractLineRange({ offset: 0, limit: 50 })).toBe("");
      expect(extractLineRange({ offset: 100, limit: 0 })).toBe("");
    });
  });

  describe("extractErrorMessage", () => {
    // 优先级 1：ACP 标准 isError=true + content[].text
    test("ACP 标准错误提取（isError + content text）", () => {
      const raw = { isError: true, content: [{ type: "text", text: "File not found" }] };
      expect(extractErrorMessage(raw)).toBe("File not found");
    });

    // ACP 标准结构但有多个内容块时只取第一个 text 块
    test("多个 content 块时取第一个 text 块", () => {
      const raw = {
        isError: true,
        content: [
          { type: "image", text: "ignored" },
          { type: "text", text: "real error" },
        ],
      };
      expect(extractErrorMessage(raw)).toBe("real error");
    });

    // 优先级 2：error 字段为字符串
    test("error 字段为字符串时直接返回（截断）", () => {
      expect(extractErrorMessage({ error: "boom" })).toBe("boom");
    });

    // error 字段为对象时取 message
    test("error 字段为对象时取 message", () => {
      expect(extractErrorMessage({ error: { message: "object boom" } })).toBe("object boom");
    });

    // 优先级 3：content 数组中最后一个 text 块（Bash stderr 等场景）
    test("无 isError 时取 content 数组最后一个 text 块", () => {
      const raw = {
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "last stderr" },
        ],
      };
      expect(extractErrorMessage(raw)).toBe("last stderr");
    });

    // 兜底：rawOutput 为空或无法识别结构
    test("rawOutput 为空返回未知错误", () => {
      expect(extractErrorMessage(undefined)).toBe("未知错误");
      expect(extractErrorMessage(null)).toBe("未知错误");
      expect(extractErrorMessage({})).toBe("未知错误");
    });

    // 长错误信息需截断到 120 字符 + 省略号
    test("超长错误信息截断到 120 字符", () => {
      const long = "x".repeat(200);
      const result = extractErrorMessage({ error: long });
      expect(result.length).toBe(121); // 120 + 省略号
      expect(result.endsWith("…")).toBe(true);
    });
  });

  describe("formatElapsed", () => {
    // <1s 显示 ms
    test("小于 1 秒显示 ms", () => {
      expect(formatElapsed(500)).toBe("500ms");
      expect(formatElapsed(999)).toBe("999ms");
    });

    // <1min 显示 s，保留 1 位小数
    test("1 秒到 1 分钟之间显示 s（1 位小数）", () => {
      expect(formatElapsed(1500)).toBe("1.5s");
      expect(formatElapsed(59_999)).toBe("60.0s");
    });

    // ≥1min 显示 m+s
    test("大于等于 1 分钟显示 m+s", () => {
      expect(formatElapsed(65_000)).toBe("1m5s");
      expect(formatElapsed(125_000)).toBe("2m5s");
    });

    // 边界值：刚好 1000ms
    test("边界值 1000ms 显示为 1.0s", () => {
      expect(formatElapsed(1000)).toBe("1.0s");
    });
  });

  describe("truncate", () => {
    // 未超长原样返回
    test("长度未超阈值原样返回", () => {
      expect(truncate("hello", 10)).toBe("hello");
    });

    // 超长加省略号
    test("超长截断加省略号", () => {
      expect(truncate("hello world", 5)).toBe("hello…");
    });

    // 刚好等于阈值不截断
    test("长度等于阈值不截断", () => {
      expect(truncate("hello", 5)).toBe("hello");
    });

    // 空字符串边界
    test("空字符串原样返回", () => {
      expect(truncate("", 10)).toBe("");
    });
  });

  describe("findFirstStringValue", () => {
    // 返回对象中第一个非空字符串值
    test("返回第一个字符串值", () => {
      expect(findFirstStringValue({ a: "first", b: "second" })).toBe("first");
    });

    // 跳过非字符串类型，返回第一个字符串
    test("跳过非字符串值找到第一个字符串", () => {
      expect(findFirstStringValue({ num: 42, bool: true, str: "found" })).toBe("found");
    });

    // 空字符串被跳过（length > 0 守卫）
    test("空字符串被跳过", () => {
      expect(findFirstStringValue({ a: "", b: "real" })).toBe("real");
    });

    // 非对象输入返回 undefined
    test("非对象输入返回 undefined", () => {
      expect(findFirstStringValue(undefined)).toBeUndefined();
      expect(findFirstStringValue(null)).toBeUndefined();
      expect(findFirstStringValue("string")).toBeUndefined();
      expect(findFirstStringValue(42)).toBeUndefined();
    });

    // 对象中无任何字符串值
    test("无字符串值的对象返回 undefined", () => {
      expect(findFirstStringValue({ a: 1, b: true })).toBeUndefined();
      expect(findFirstStringValue({})).toBeUndefined();
    });
  });
});
