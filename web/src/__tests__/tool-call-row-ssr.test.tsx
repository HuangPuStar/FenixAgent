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
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(ToolCallRow, { tool: value })));
}

describe("ToolCallRow 服务端渲染", () => {
  // 已完成文件读取应展示工具名称、摘要和参数入口，方便用户查看执行结果。
  test("完成的读取工具展示摘要与详情入口", () => {
    const html = renderTool(tool());

    expect(html).toContain("common.subtitle");
    expect(html).toContain("common.status.complete");
    expect(html).toContain('class="chat-tool-call-row"');
    expect(html).toContain('data-kind="read-file"');
    expect(html).not.toContain('class="chat-tool-call-row" data-kind="read-file" disabled=""');
    expect(html).toContain("toolCallRow.previewFile");
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

  // 无参数和结果的行没有详情可打开，native button 必须禁用且不能伪装成可点击行。
  test("无详情工具行使用 disabled 语义", () => {
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

    expect(html).toContain('class="chat-tool-call-row" data-kind="bash" disabled=""');
  });

  // data-kind 只描述工具语义；即使 kind 相同，有详情与无详情仍由 disabled 决定交互性。
  test("同一 kind 的交互性由详情状态决定", () => {
    const enabled = renderTool(tool({ kind: "unknown", rawInput: { value: 1 } }));
    const disabled = renderTool(
      tool({ kind: "unknown", status: "running", rawInput: undefined, rawOutput: undefined, content: undefined }),
    );

    expect(enabled).toContain('data-kind="unknown"');
    expect(enabled).not.toContain('data-kind="unknown" disabled=""');
    expect(disabled).toContain('data-kind="unknown" disabled=""');
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
