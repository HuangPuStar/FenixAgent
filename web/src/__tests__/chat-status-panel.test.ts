import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";

import { ChatStatusPanel, fileNameFromPath } from "../../components/chat/chat-status-panel";
import i18n from "../i18n";

function renderPanel(props: Partial<Parameters<typeof ChatStatusPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ChatStatusPanel, {
        todos: [],
        tasks: [],
        tasksLoaded: true,
        changedFiles: [],
        ...props,
      }),
    ),
  );
}

describe("ChatStatusPanel 文件名称", () => {
  // Changes 只展示文件名，完整绝对路径继续由状态面板保留用于预览定位。
  test("从 Unix 绝对路径提取文件名", () => {
    expect(fileNameFromPath("/opt/app/tmp/session/src/agent-sites.md")).toBe("agent-sites.md");
  });

  // Windows 路径也应按文件名展示，避免平台差异泄漏完整工作区路径。
  test("从 Windows 路径提取文件名", () => {
    expect(fileNameFromPath("C:\\workspace\\src\\agent-sites.md")).toBe("agent-sites.md");
  });

  // 目录型路径没有末尾文件段时回退到最后一个有效目录名。
  test("忽略路径末尾斜杠", () => {
    expect(fileNameFromPath("/opt/app/project/")).toBe("project");
  });

  // Todo、Subtasks 与 Changes 共用同一限高滚动容器，长列表不得继续抬高输入区。
  test("三个状态列表都限制高度并启用内部滚动", () => {
    const todoMarkup = renderPanel({ todos: [{ content: "检查待办", status: "pending" }] });
    const taskMarkup = renderPanel({
      tasks: [
        {
          taskId: "task-1",
          title: "检查子任务",
          kind: "subagent",
          taskSubtype: null,
          summary: null,
          status: "running",
          turnId: null,
          isBackground: false,
          startedAt: "2026-09-09T00:00:00.000Z",
          completedAt: null,
          updatedAt: "2026-09-09T00:00:00.000Z",
          detailAvailability: "unavailable",
        },
      ],
    });
    const changesMarkup = renderPanel({ changedFiles: [{ path: "/workspace/src/app.ts", type: "edit" }] });

    for (const markup of [todoMarkup, taskMarkup, changesMarkup]) {
      expect(markup).toContain("max-h-[min(16rem,35vh)] overflow-y-auto overscroll-contain [scrollbar-gutter:stable]");
    }
  });
});
