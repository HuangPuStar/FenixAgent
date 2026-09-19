/**
 * chat 分区示例：工具时间线层（ToolCallGroup 各 kind、子 Agent 嵌套、Hindsight 记忆卡）。
 *
 * 工具数据来自包内 mocks 的 `createMockChatEntries()`，并补三条 mock 未覆盖的形态（Skill、MCP 工具、
 * Hindsight 记忆卡）；文件预览走纯化后的 `onPreviewFile` 回调。
 */

import { type ToolCallEntry, ToolCallGroup } from "@fenix/ui-components";
import { createMockChatEntries } from "@fenix/ui-components/chat/mocks/mock-fixtures";
import { useMemo, useState } from "react";

/** mock 会话未覆盖的三条工具形态：Skill、MCP（unknown kind）、Hindsight 记忆工具。 */
const EXTRA_TOOL_ENTRIES: ToolCallEntry[] = [
  {
    type: "tool_call",
    toolCall: {
      id: "demo-tool-skill",
      title: "Skill",
      kind: "skill",
      status: "complete",
      rawInput: { name: "codebase-design" },
      rawOutput: { loaded: true },
    },
  },
  {
    type: "tool_call",
    toolCall: {
      id: "demo-tool-mcp",
      title: "mcp__github__create_issue",
      kind: "unknown",
      status: "complete",
      rawInput: { title: "[chat] 回调替换清单" },
    },
  },
  {
    type: "tool_call",
    toolCall: {
      id: "demo-tool-hindsight",
      title: "hindsight_recall",
      kind: "unknown",
      status: "complete",
      rawInput: { query: "chat 组件库的命名约定" },
      rawOutput: { memories: ["包内组件保持源文件名与源组件名，便于与源同步。"] },
    },
  },
];

/** 工具时间线示例组。 */
export function ChatTimelineExamples() {
  const [previewedPath, setPreviewedPath] = useState<string | null>(null);

  // mock 时间线里只有工具调用条目能进 ToolCallGroup（用户/助手消息由消息视图渲染）。
  const toolEntries = useMemo(
    () => [
      ...createMockChatEntries().filter((entry): entry is ToolCallEntry => entry.type === "tool_call"),
      ...EXTRA_TOOL_ENTRIES,
    ],
    [],
  );

  return (
    <div className="demo-example">
      <h2 className="demo-example-title">ToolCallGroup（各 kind + 子 Agent + 待确认 + Hindsight）</h2>
      <ToolCallGroup entries={toolEntries} onPreviewFile={setPreviewedPath} />
      <p className="demo-hint">
        {previewedPath === null
          ? "点击文件类卡片上的文件名可触发 onPreviewFile；点右侧详情图标查看入参/出参原始 JSON。"
          : `onPreviewFile → ${previewedPath}`}
      </p>
    </div>
  );
}
