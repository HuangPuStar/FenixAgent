import { describe, expect, test } from "bun:test";
import {
  CARD_STYLES,
  cardKindToStyle,
  formatOutput,
  isHindsightTool,
  kindLabel,
  simplifyToolName,
  supportsFilePreview,
  truncate,
} from "../../components/chat/tool-call-utils";
import type { ToolCallData, ToolCardKind } from "../lib/types";

function createTool(overrides: Partial<ToolCallData> = {}): ToolCallData {
  return {
    id: "tool_1",
    title: "Read",
    status: "complete",
    ...overrides,
  };
}

describe("tool-call-utils", () => {
  // 已知工具类型必须返回各自预定义的视觉样式，避免卡片展示退化为默认样式。
  test("已知工具类型返回对应卡片样式", () => {
    expect(cardKindToStyle("bash")).toBe(CARD_STYLES.bash);
    expect(cardKindToStyle("web-search")).toBe(CARD_STYLES["web-search"]);
  });

  // 运行时收到不受信任的未知类型时，应安全回退为 unknown 样式。
  test("未知工具类型回退为默认卡片样式", () => {
    expect(cardKindToStyle("future-tool" as ToolCardKind)).toBe(CARD_STYLES.unknown);
  });

  // 文件预览只允许读取、编辑和写入类工具，避免为无关工具展示无效入口。
  test("文件操作工具支持预览", () => {
    expect(supportsFilePreview("read-file")).toBe(true);
    expect(supportsFilePreview("edit")).toBe(true);
    expect(supportsFilePreview("write")).toBe(true);
  });

  // 非文件类工具不得错误启用文件预览能力。
  test("非文件工具不支持预览", () => {
    expect(supportsFilePreview("read-directory")).toBe(false);
    expect(supportsFilePreview("bash")).toBe(false);
  });

  // 新协议的 kind 值应直接映射为稳定的可读名称。
  test("已知 kind 映射为可读名称", () => {
    expect(simplifyToolName("read-file")).toBe("Read");
    expect(simplifyToolName("web-fetch")).toBe("Fetch");
  });

  // MultiEdit 必须优先于通用 edit 规则匹配，保留更具体的工具语义。
  test("优先识别 MultiEdit 工具名称", () => {
    expect(simplifyToolName("MultiEditFile")).toBe("MultiEdit");
    expect(simplifyToolName("multi_edit_file")).toBe("MultiEdit");
  });

  // 历史编辑工具名称仍应归类到 Edit，保障旧会话展示一致。
  test("兼容历史编辑工具名称", () => {
    expect(simplifyToolName("str_replace_editor")).toBe("Edit");
  });

  // shell、command 等历史别名应统一显示为 Bash。
  test("兼容 shell 与 command 工具别名", () => {
    expect(simplifyToolName("Shell Execute")).toBe("Bash");
    expect(simplifyToolName("command")).toBe("Bash");
  });

  // 搜索和任务工具应通过各自的前缀规则正确分类。
  test("识别搜索和任务工具名称", () => {
    expect(simplifyToolName("grep_files")).toBe("Grep");
    expect(simplifyToolName("GlobFiles")).toBe("Glob");
    expect(simplifyToolName("TaskRunner")).toBe("Task");
  });

  // 精确 kind 优先走映射表；历史 TodoWrite 因通用 write 规则优先而保持 Write 展示。
  test("待办 kind 与历史 TodoWrite 保持既有优先级", () => {
    expect(simplifyToolName("todo")).toBe("Todo");
    expect(simplifyToolName("TodoWrite")).toBe("Write");
  });

  // 未知但以字母开头的名称应保留首个单词并规范首字母，提供可读兜底。
  test("未知字母工具名称使用规范化首词", () => {
    expect(simplifyToolName("CUSTOM_tool-v2")).toBe("Custom");
  });

  // 不含字母的未知名称不应被改写，以免丢失原始诊断信息。
  test("纯符号工具名称保持原样", () => {
    expect(simplifyToolName("---")).toBe("---");
  });

  // kindLabel 应提供已知类型标签，并为空的 unknown 类型保留空文案。
  test("kindLabel 返回已知标签和 unknown 空标签", () => {
    expect(kindLabel("question")).toBe("Question");
    expect(kindLabel("unknown")).toBe("");
  });

  // 截断阈值内及恰好阈值的内容必须完整保留，避免无谓省略。
  test("短文本和边界长度文本不截断", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("ab", 3)).toBe("ab");
  });

  // 超过阈值的内容要截断并追加单字符省略号，限制卡片输出尺寸。
  test("超长文本截断并追加省略号", () => {
    expect(truncate("abcd", 3)).toBe("abc…");
  });

  // Hindsight 工具判断应忽略大小写，保证不同引擎的命名都能被筛选。
  test("识别大小写不同的 Hindsight 工具", () => {
    expect(isHindsightTool("hindsight_search")).toBe(true);
    expect(isHindsightTool("HINDSIGHT_LOOKUP")).toBe(true);
  });

  // 仅包含相似单词但不以前缀开头的工具不能被误判为 Hindsight。
  test("非 Hindsight 前缀不被误判", () => {
    expect(isHindsightTool("search_hindsight")).toBe(false);
  });

  // content 中的文本块优先于 rawOutput，且多个文本块按原顺序以换行拼接。
  test("优先格式化 content 中的文本输出", () => {
    const output = formatOutput(
      createTool({
        content: [
          { type: "content", content: { type: "text", text: "first" } },
          { type: "terminal", terminalId: "terminal-1" },
          { type: "content", content: { type: "text", text: "second" } },
        ],
        rawOutput: { fallback: true },
      }),
    );

    expect(output).toBe("first\nsecond");
  });

  // 非文本 content 不产生展示文本时，应回退格式化结构化 rawOutput。
  test("非文本 content 时回退 rawOutput", () => {
    expect(
      formatOutput(
        createTool({
          content: [{ type: "content", content: { type: "image" } }],
          rawOutput: { ok: true },
        }),
      ),
    ).toBe('{\n  "ok": true\n}');
  });

  // 空 content 与空对象 rawOutput 都不应生成虚假输出。
  test("空内容和空 rawOutput 返回空字符串", () => {
    expect(formatOutput(createTool({ content: [], rawOutput: {} }))).toBe("");
  });

  // 超长工具输出必须使用统一上限截断，防止详情区域渲染过大的响应。
  test("超长 content 输出按两千字符截断", () => {
    const output = formatOutput(
      createTool({ content: [{ type: "content", content: { type: "text", text: "x".repeat(2001) } }] }),
    );

    expect(output).toBe(`${"x".repeat(2000)}…`);
  });
});
