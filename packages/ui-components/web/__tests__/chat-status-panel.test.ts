import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { initReactI18next } from "react-i18next/initReactI18next";
import { ChatStatusPanel, fileNameFromPath } from "../chat/panels/chat-status-panel";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

/**
 * 输入框上方状态面板（`web/chat/panels/chat-status-panel`）的行为测试。
 *
 * 迁移自 `packages/agent-runtime/web/__tests__/chat-status-panel.test.ts`（CE 阶段 2 §1.6 T6c1）。
 * 纯化改动：i18n 由宿主 `@/src/i18n` 换成包内字典；面板改为纯 SSR 渲染，不需要 DOM 引导
 * （`renderToStaticMarkup` 不进 happy-dom 也走通），断言全部落在 `aria-*` / `role` / class 契约上，
 * 与包内 `.chat-status-list` 的 data-* 契约一致，不依赖具体译文。
 */

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});

/** 读取组件同目录的样式表原文：深层样式（限高/列定义/投影等复合值）从 `className` 下沉到了那里。 */
function readStatusPanelCss(): string {
  return readFileSync(join(import.meta.dir, "..", "chat", "panels", "chat-status-panel.css"), "utf8");
}

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

  // 文件变更首次成为唯一状态时只展示 Changes 摘要，不主动挤占消息区。
  test("Changes 首次出现时保持折叠", () => {
    const markup = renderPanel({ changedFiles: [{ path: "/workspace/src/app.ts", type: "edit" }] });

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('role="tabpanel"');
  });

  // Todo 首次出现时仍直接展示内容，便于跟踪当前执行计划。
  test("Todo 首次出现时自动展开", () => {
    const markup = renderPanel({ todos: [{ content: "检查待办", status: "pending" }] });

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('role="tabpanel"');
  });

  // Background Tasks 对应 tasks 状态页，首次出现时仍直接展示运行状态。
  test("Background Tasks 首次出现时自动展开", () => {
    const markup = renderPanel({
      tasks: [
        {
          taskId: "task-1",
          title: "后台检查",
          kind: "subagent",
          taskSubtype: null,
          summary: null,
          status: "running",
          turnId: null,
          isBackground: true,
          startedAt: "2026-09-09T00:00:00.000Z",
          completedAt: null,
          updatedAt: "2026-09-09T00:00:00.000Z",
          detailAvailability: "unavailable",
        },
      ],
    });

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('role="tabpanel"');
  });

  // Todo 与 Background Tasks 共用同一限高滚动容器，长列表不得继续抬高输入区。
  test("自动展开的状态列表限制高度并启用内部滚动", () => {
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
    for (const markup of [todoMarkup, taskMarkup]) {
      // 迁移后容器类里还含有列表自身的 grid/内边距工具类，故逐条断言限高与滚动契约（同一条不可少）：
      // 限高的复合值（源 `max-h-[min(16rem,35vh)]`）已下沉到 `panels/chat-status-panel.css` 的
      // `.chat-status-rows`，故这里改断语义类名 + 样式表原文。
      expect(markup).toContain("chat-status-rows");
      expect(readStatusPanelCss()).toContain("max-height: min(16rem, 35vh)");
      expect(markup).toContain("overflow-y-auto");
      expect(markup).toContain("overscroll-contain");
      expect(markup).toContain("[scrollbar-gutter:stable]");
      expect(markup).toContain('data-slot="chat-status-list"');
    }
  });
});
