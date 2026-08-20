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

    expect(html).toContain("src/app.ts");
    expect(html).toContain("common.status.complete");
    expect(html).toContain("toolCallRow.viewParams");
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
        publicError: { code: "PERMISSION_DENIED", message: "没有写入权限" },
      }),
    );

    expect(html).toContain("没有写入权限");
    expect(html).toContain("common.status.error");
    expect(html).toContain("toolCallRow.previewFile");
  });

  // 等待确认的工具不得开放详情弹窗，而应渲染权限决策入口。
  test("等待确认工具展示权限操作", () => {
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
    expect(html).toContain("允许");
    expect(html).toContain("拒绝");
  });
});
