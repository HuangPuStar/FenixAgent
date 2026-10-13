/**
 * 工具调用纯逻辑（`web/chat/lib/tool-call-utils.ts`）的回归测试。
 *
 * 来源：`packages/agent-runtime/web/__tests__/acp-main-round45-pure.test.ts` 逐条迁移。
 * 纯化改动点：被测模块改指包内 `../chat/lib/tool-call-utils`，类型改指包内 `../chat/types`；
 * 本文件不渲染 React、不触碰 DOM，因此不需要 happy-dom / i18n 引导。
 * （`truncate` 的两条用例随实现于 2026-10-10 迁入 `format.test.ts`。）
 */

import { describe, expect, test } from "bun:test";
import {
  cardKindToStyle,
  formatOutput,
  isHindsightTool,
  kindLabel,
  simplifyToolName,
  supportsFilePreview,
} from "../chat/lib/tool-call-utils";
import type { ToolCallData } from "../chat/types";

function createTool(overrides: Partial<ToolCallData> = {}): ToolCallData {
  return {
    id: "round45-tool",
    title: "Read",
    status: "complete",
    ...overrides,
  };
}

describe("ACPMain 依赖的工具调用纯逻辑", () => {
  // 目录读取不是文件内容操作，不能打开文件预览。
  test("read-directory 不支持文件预览", () => {
    expect(supportsFilePreview("read-directory")).toBe(false);
  });

  // 搜索工具不产生可编辑文件，不应误开放预览入口。
  test("grep 不支持文件预览", () => {
    expect(supportsFilePreview("grep")).toBe(false);
  });

  // 未知类型的样式必须回退到灰色安全样式。
  test("unknown 使用默认卡片样式", () => {
    expect(cardKindToStyle("unknown").iconColor).toBe("text-gray-500 dark:text-gray-400");
  });

  // 同属读取类别的 glob 应保留对应青色视觉语义。
  test("glob 使用青色卡片样式", () => {
    expect(cardKindToStyle("glob").cardBg).toBe("bg-cyan-50/40 dark:bg-cyan-950/20");
  });

  // 精确的 write kind 应优先于旧标题解析规则。
  test("write kind 映射为 Write", () => {
    expect(simplifyToolName("write")).toBe("Write");
  });

  // 旧协议的大小写混合 Bash 标题也应归一为 Bash。
  test("旧 Bash 标题映射为 Bash", () => {
    expect(simplifyToolName("RunBashCommand")).toBe("Bash");
  });

  // 含有 read 的旧标题应被识别为读取操作。
  test("旧读取标题映射为 Read", () => {
    expect(simplifyToolName("ReadFileContent")).toBe("Read");
  });

  // 连字符形式的 web-fetch 属于已知 kind，必须优先映射为 Fetch。
  test("web-fetch kind 映射为 Fetch", () => {
    expect(simplifyToolName("web-fetch")).toBe("Fetch");
  });

  // 旧 todo_write 标题会先匹配通用 write 规则，保持现有展示优先级。
  test("todo_write 标题遵循 Write 优先级", () => {
    expect(simplifyToolName("todo_write_items")).toBe("Write");
  });

  // task 前缀应识别为委派任务工具。
  test("task 前缀标题映射为 Task", () => {
    expect(simplifyToolName("task_status")).toBe("Task");
  });

  // 已知类型标签应返回展示名称而非原始协议值。
  test("web-search 的标签为 Search", () => {
    expect(kindLabel("web-search")).toBe("Search");
  });

  // 只有精确的 hindsight_ / mcp__hindsight__ / agent_knowledge_ 前缀才属于 Hindsight 工具。
  test("hindsight 前缀缺少下划线时不匹配", () => {
    expect(isHindsightTool("hindsightSearch")).toBe(false);
  });

  // content 存在但没有文本块时，应使用非空 rawOutput 作为诊断输出。
  test("仅终端块时回退到 rawOutput", () => {
    expect(
      formatOutput(
        createTool({
          content: [{ type: "terminal", terminalId: "terminal-1" }],
          rawOutput: { code: 0 },
        }),
      ),
    ).toBe('{\n  "code": 0\n}');
  });

  // 未提供 content 且 rawOutput 为数组时，应保留 JSON 数组格式。
  test("数组 rawOutput 格式化为 JSON", () => {
    expect(formatOutput(createTool({ rawOutput: { items: ["first", "second"] } }))).toBe(
      '{\n  "items": [\n    "first",\n    "second"\n  ]\n}',
    );
  });

  // 文本内容可用时，即使 rawOutput 为空数组也必须优先展示文本。
  test("文本 content 优先于空数组 rawOutput", () => {
    expect(
      formatOutput(
        createTool({
          content: [{ type: "content", content: { type: "text", text: "可读输出" } }],
          rawOutput: {},
        }),
      ),
    ).toBe("可读输出");
  });
});
