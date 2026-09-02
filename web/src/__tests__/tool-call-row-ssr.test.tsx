import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";

import { ToolCallRow } from "../../components/chat/ToolCallRow";
import i18n from "../i18n";
import type { ToolCallData } from "../lib/types";

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
    createElement(I18nextProvider, { i18n }, createElement(ToolCallRow, { tool: value, envId: "env-ssr" })),
  );
}

describe("ToolCallRow 服务端渲染", () => {
  // 已完成文件读取应将文件名直接渲染为预览入口，并保留独立参数入口。
  test("完成的读取工具展示可点击文件名与详情入口", () => {
    const html = renderTool(tool());

    expect(html).toContain("common.subtitle");
    expect(html).toContain("common.status.complete");
    expect(html).toContain('class="chat-tool-call-row"');
    expect(html).toContain('data-kind="read-file"');
    expect(html).toContain('class="tool-call-row-file-link"');
    expect(html).toContain("app.ts");
    expect(html).toContain('class="chat-tool-call-row-details-button"');
    expect(html).not.toContain("toolCallRow.openFile");
  });

  // Read 的行号范围应紧跟文件名展示，不再被推到工具行中间的独立列。
  test("读取工具将行号范围显示在文件名之后", () => {
    const html = renderTool(tool({ rawInput: { file_path: "src/app.ts", offset: 68, limit: 140 } }));

    expect(html).toContain("tool-call-row-copy is-file-preview");
    expect(html).toMatch(/tool-call-row-file-link[\s\S]*app\.ts[\s\S]*tool-call-row-meta[\s\S]*common\.lineRange/);
  });

  // 运行中的工具需要展示进行中状态，避免被误认为已成功结束。
  test("运行中工具展示活动状态", () => {
    const html = renderTool(tool({ title: "Bash", kind: "bash", status: "running", rawOutput: undefined }));

    expect(html).toContain("common.status.running");
    expect(html).toContain("animate-spin");
  });

  // 脱敏错误应被显示给用户，同时保留失败状态，帮助其决定是否重试。
  test("失败工具展示公开错误", () => {
    const html = renderTool(
      tool({
        title: "Write",
        kind: "write",
        status: "error",
        publicError: {
          type: "ACTION.FAILED",
          id: "err_00000000000000000000000000000001",
          message: "操作未能完成。",
        },
      }),
    );

    expect(html).toContain("操作未能完成。");
    expect(html).toContain("Type: ACTION.FAILED");
    expect(html).toContain("ID: err_00000000000000000000000000000001");
    expect(html).toContain("tool-call-row-heading");
    expect(html).toContain('class="tool-call-row-error"');
    expect(html).toContain("common.status.error");
    expect(html).toContain("toolCallRow.previewFile");
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

    expect(html).toContain('class="chat-tool-call-row" data-kind="bash"');
    expect(html).not.toContain('class="chat-tool-call-row-details-button"');
  });

  // data-kind 只描述工具语义；同一 kind 是否展示详情入口取决于是否存在参数或结果。
  test("同一 kind 的详情入口由内容决定", () => {
    const enabled = renderTool(tool({ kind: "unknown", rawInput: { value: 1 } }));
    const disabled = renderTool(
      tool({ kind: "unknown", status: "running", rawInput: undefined, rawOutput: undefined, content: undefined }),
    );

    expect(enabled).toContain('data-kind="unknown"');
    expect(enabled).toContain('class="chat-tool-call-row-details-button"');
    expect(disabled).toContain('data-kind="unknown"');
    expect(disabled).not.toContain('class="chat-tool-call-row-details-button"');
  });

  // 等待确认工具只保留状态，权限选项统一由输入框上方交互区域承载。
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

    expect(html).toContain("common.status.waiting_for_confirmation");
    expect(html).not.toContain("允许");
    expect(html).not.toContain("拒绝");
  });
});
