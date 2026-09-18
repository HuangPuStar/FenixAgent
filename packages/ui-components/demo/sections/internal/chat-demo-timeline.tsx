/**
 * chat 分区示例：工具时间线层（ToolCallGroup 各 kind、子 Agent 嵌套、Hindsight 记忆卡、Peri Task）。
 *
 * 工具数据来自包内 mocks 的 `createMockChatEntries()`，并补三条 mock 未覆盖的形态（Skill、MCP 工具、
 * Hindsight 记忆卡）；文件预览走纯化后的 `onPreviewFile` 回调，Peri Task 详情走宿主注入的
 * `loadDetail`（mock 不含该端口，示例在本地用延迟兑现，契约与源实现一致）。
 */

import {
  type PeriTaskDetail,
  PeriTaskDetailSheet,
  PeriTaskList,
  PeriTaskViewCard,
  type PeriTaskViewProjection,
  type ToolCallEntry,
  ToolCallGroup,
} from "@fenix/ui-components";
import type { MockChatSession } from "@fenix/ui-components/chat/mocks/mock-chat-store";
import { createMockChatEntries } from "@fenix/ui-components/chat/mocks/mock-fixtures";
import { useCallback, useMemo, useState } from "react";

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

/** Peri Task 详情加载器的延迟（毫秒）。 */
const DETAIL_DELAY_MS = 400;

/** 工具时间线示例组。 */
export function ChatTimelineExamples({ session }: { session: MockChatSession }) {
  const [previewedPath, setPreviewedPath] = useState<string | null>(null);
  const [detailTask, setDetailTask] = useState<PeriTaskViewProjection | null>(null);

  // mock 时间线里只有工具调用条目能进 ToolCallGroup（用户/助手消息由消息视图渲染）。
  const toolEntries = useMemo(
    () => [
      ...createMockChatEntries().filter((entry): entry is ToolCallEntry => entry.type === "tool_call"),
      ...EXTRA_TOOL_ENTRIES,
    ],
    [],
  );

  // mock 不提供详情端口：示例用本地延迟兑现宿主契约（支持 AbortSignal 取消）。
  const loadDetail = useCallback(
    async (taskId: string, signal: AbortSignal): Promise<PeriTaskDetail> => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, DETAIL_DELAY_MS);
        function onAbort() {
          clearTimeout(timer);
          reject(new DOMException("demo detail aborted", "AbortError"));
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
      const task = session.periTasks.find((candidate) => candidate.taskId === taskId);
      if (!task || task.detailAvailability === "unavailable" || task.detailAvailability === "expired") {
        return {
          kind: "unavailable",
          taskId,
          taskKind: "subagent",
          reason: task?.detailAvailability === "expired" ? "expired" : "not_provided",
        };
      }
      return {
        kind: "preview",
        taskId,
        taskKind: "subagent",
        items: [
          { type: "text", content: task.title },
          { type: "text", content: task.summary ?? "（该任务没有可展示的摘要）" },
        ],
        nextCursor: null,
        complete: false,
        limitation: "source_only_provides_preview",
      };
    },
    [session.periTasks],
  );

  return (
    <>
      <div className="demo-example">
        <h2 className="demo-example-title">ToolCallGroup（各 kind + 子 Agent + 待确认 + Hindsight）</h2>
        <ToolCallGroup entries={toolEntries} onPreviewFile={setPreviewedPath} />
        <p className="demo-hint">
          {previewedPath === null
            ? "点击文件类卡片上的文件名可触发 onPreviewFile；点右侧详情图标查看入参/出参原始 JSON。"
            : `onPreviewFile → ${previewedPath}`}
        </p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">PeriTaskList / PeriTaskViewCard / PeriTaskDetailSheet</h2>
        <PeriTaskList tasks={session.periTasks} loaded={session.periTasksLoaded} onOpenDetail={setDetailTask} />
        <div className="mt-4 flex flex-col gap-2">
          {session.periTasks.map((task) => (
            <PeriTaskViewCard key={task.taskId} task={task} onOpenDetail={setDetailTask} />
          ))}
        </div>
        <PeriTaskDetailSheet task={detailTask} loadDetail={loadDetail} onClose={() => setDetailTask(null)} />
        <p className="demo-hint">
          点击任务卡片打开抽屉：可预览的任务显示有界摘要（400ms 加载态），不可用/已过期的任务展示对应占位。
        </p>
      </div>
    </>
  );
}
