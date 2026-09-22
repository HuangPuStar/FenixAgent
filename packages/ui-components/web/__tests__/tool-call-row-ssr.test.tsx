// ToolCallRow 的服务端渲染测试（CE 阶段 2 §1.6 T6c1 从
// `packages/agent-runtime/web/__tests__/tool-call-row-ssr.test.tsx` 迁入包内，
// 旧聊天实现整体退场，用例随实现迁入 owner 包）。
//
// 迁移改动（用例名与中文注释逐字保留，只按包内契约改写断言的取值来源）：
// - 导入路径按 A→B 表改写：`../components/chat/ToolCallRow` → `../chat/timeline/ToolCallRow`，
//   `../lib/types` → `../chat/types`。
// - i18n 从宿主 `@/src/i18n` 单例换成包内 `createInstance` + `../i18n/locales/en/uiComponents.json`
//   （组件文案键前缀由 `components.*` 变为 `chat.components.*`，narrator 文案由 `toolNarrator.*`
//   变为 `chat.toolNarrator.*`）。SSR 不需要 DOM 引导，故不引入 happy-dom。
// - `envId` prop 已随纯化去掉：源实现要 `envId` 才渲染文件链接（点击时派发
//   `artifacts:preview-file` 事件），包内改为宿主注入 `onPreviewFile` 回调；`renderTool` 统一注入
//   该回调，保持「宿主具备文件预览能力」这一旧用例前提。
// - 保留注释里引用的 `components/chat/ToolCallRow.tsx` 是迁移前的路径，包内现为
//   `web/chat/timeline/ToolCallRow.tsx`。
// - 已登记的有意取舍（`docs/design/ce-ee-refactoring/review/task-1.6-web-shell.md` §8.2 第 1 行、
//   `packages/ui-components/README.md`「纯化决策（相对 apps/web 源实现）」表中 `ToolCallRow.tsx` 行）：
//   「失败工具展示公开错误」用例删除——
//   包内只保留标题下方第二行的 `errorDetail`（`narrate` 优先取 `publicError.message`），
//   不再渲染该块右侧的 `Type:` / `ID:` 两行，故该用例的 Type / ID 断言在包内无对应行为。

import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { initReactI18next } from "react-i18next/initReactI18next";
import { ToolCallRow } from "../chat/timeline/ToolCallRow";
import type { ToolCallData } from "../chat/types";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

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

function tool(overrides: Partial<ToolCallData> = {}): ToolCallData {
  return {
    id: "tool-ssr",
    title: "Read",
    status: "complete",
    kind: "read-file",
    rawInput: { file_path: "src/app.ts" },
    rawOutput: { content: "export const answer = 42;" },
    ...overrides,
  };
}

function renderTool(value: ToolCallData): string {
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      // 包内文件链接由宿主回调门控（源实现是 `envId` + window 事件），这里注入空回调
      createElement(ToolCallRow, { tool: value, onPreviewFile: () => {} }),
    ),
  );
}

describe("ToolCallRow 服务端渲染", () => {
  // 已完成文件读取应将文件名直接渲染为预览入口，并保留独立参数入口。
  test("完成的读取工具展示可点击文件名与详情入口", () => {
    const html = renderTool(tool());

    expect(html).toContain('data-slot="chat-tool-call-row"');
    expect(html).toContain('data-kind="read-file"');
    expect(html).toContain('data-slot="chat-tool-call-file-link"');
    expect(html).toContain("app.ts");
    expect(html).toContain('data-slot="chat-tool-call-details-button"');
    expect(html).not.toContain("toolCallRow.openFile");
  });

  // Read 的行号范围应紧跟文件名展示，不再被推到工具行中间的独立列。
  // 行号范围是唯一渲染进行内 meta 槽的内容（见 components/chat/ToolCallRow.tsx），
  // 因此按承载元素定位即可验证顺序，不依赖随 i18n 状态变化的范围文案本身。
  test("读取工具将行号范围显示在文件名之后", () => {
    const html = renderTool(tool({ rawInput: { file_path: "src/app.ts", offset: 68, limit: 140 } }));

    expect(html).toContain('data-slot="chat-tool-call-copy"');
    expect(html).toMatch(/chat-tool-call-file-link[\s\S]*app\.ts[\s\S]*chat-tool-call-meta/);
  });

  // 所有工具的补充详情都应紧跟工具名称，避免在宽屏下形成远离名称的独立列。
  test("普通工具将详情显示在工具名称之后", () => {
    const html = renderTool(
      tool({
        title: "Grep",
        kind: "grep",
        rawInput: { pattern: "answer", path: "src" },
        rawOutput: { count: 1 },
      }),
    );

    expect(html).toMatch(
      /chat-tool-call-heading[\s\S]*data-slot="chat-tool-call-title"[\s\S]*<\/span>[\s\S]*chat-tool-call-meta/,
    );
    expect(html).not.toContain("<strong");
  });

  // 运行中的工具需要展示进行中状态，避免被误认为已成功结束。
  test("运行中工具展示活动状态", () => {
    const html = renderTool(tool({ title: "Bash", kind: "bash", status: "running", rawOutput: undefined }));

    expect(html).toContain("animate-spin");
  });

  // 无参数和结果的行不应渲染详情按钮，避免伪装成可交互元素。
  test("无详情工具行不展示详情入口", () => {
    const html = renderTool(
      tool({
        title: "Bash",
        kind: "bash",
        status: "running",
        rawInput: undefined,
        rawOutput: undefined,
        content: undefined,
      }),
    );

    // 同一元素上同时带锚点与 kind（属性顺序不固定，故用同一标签内的正则匹配）。
    expect(html).toMatch(/data-kind="bash"[^>]*data-slot="chat-tool-call-row"/);
    expect(html).not.toContain('data-slot="chat-tool-call-details-button"');
  });

  // data-kind 只描述工具语义；同一 kind 是否展示详情入口取决于是否存在参数或结果。
  test("同一 kind 的详情入口由内容决定", () => {
    const enabled = renderTool(tool({ kind: "unknown", rawInput: { value: 1 } }));
    const disabled = renderTool(
      tool({ kind: "unknown", status: "running", rawInput: undefined, rawOutput: undefined, content: undefined }),
    );

    expect(enabled).toContain('data-kind="unknown"');
    expect(enabled).toContain('data-slot="chat-tool-call-details-button"');
    expect(disabled).toContain('data-kind="unknown"');
    expect(disabled).not.toContain('data-slot="chat-tool-call-details-button"');
  });

  // TodoWrite 的变更记录必须在工具卡片内部限高滚动，避免长变更列表撑满会话。
  test("TodoWrite 变更列表限制高度并内部滚动", () => {
    const html = renderTool(
      tool({
        title: "TodoWrite",
        kind: "unknown",
        todoChanges: [
          {
            id: "todo-change-1",
            kind: "added",
            todo: { content: "检查长列表布局", status: "pending" },
          },
        ],
      }),
    );

    expect(html).toContain("max-h-64 overflow-y-auto overscroll-contain");
    expect(html).toContain("检查长列表布局");
  });

  // 等待确认工具只保留状态，权限选项统一由输入框上方交互区域承载。
  // 状态文案随 i18n 状态变化，这里按承载它的状态槽锚点断言状态区仍存在，
  // 否则两条否定断言在整行未渲染时也会通过。
  test("等待确认工具不重复渲染权限操作", () => {
    const html = renderTool(
      tool({
        title: "Delete",
        kind: "unknown",
        status: "waiting_for_confirmation",
        permissionRequest: {
          requestId: "permission-ssr",
          options: [
            { optionId: "allow", name: "允许", kind: "allow_once" },
            { optionId: "deny", name: "拒绝", kind: "reject_once" },
          ],
        },
      }),
    );

    expect(html).toContain('data-slot="chat-tool-call-status"');
    expect(html).not.toContain("允许");
    expect(html).not.toContain("拒绝");
  });
});
