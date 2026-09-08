import { describe, expect, test } from "bun:test";
import { hasAgentGenerationPrompt } from "../pages/agent-panel/pages/AgentHomePage";

describe("Agent 首页生成输入校验", () => {
  // 空字符串和纯空白不应启用一键创建，避免点击按钮后没有任何反馈。
  test("拒绝空白描述", () => {
    expect(hasAgentGenerationPrompt("")).toBe(false);
    expect(hasAgentGenerationPrompt(" \n\t ")).toBe(false);
  });

  // 包含实际内容的描述应允许进入 Agent 配置生成流程。
  test("接受有效描述", () => {
    expect(hasAgentGenerationPrompt("创建一个代码审查 Agent")).toBe(true);
  });
});
