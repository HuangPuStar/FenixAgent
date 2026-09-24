// web/__tests__/agent-home-generation.test.tsx
// 守护「创建智能体」首页的生成输入校验与创建后导航契约。
//
// §1.6 T11e-3c 随被测页面（`web/pages/agent-panel/pages/AgentHomePage.tsx`）从宿主
// `apps/web/src/__tests__/` 迁入，相对路径不变但落点已从「应用壳读包内实现」变成包内自持。
//
// §4.8 拆分（2026-09-23）：创建流程的编排移到同目录 `agent-home-creation.ts`，导航仍留在页面。
// 下面对「显式进入实例 + 携带实例 UID 导航」的断言改为**同时读两份源码**——契约没变，
// 只是它的两半不再同处一个文件（若只在其中一份里保留，另一份的改动就会漏网）。

import { describe, expect, test } from "bun:test";
import { hasAgentGenerationPrompt } from "../pages/agent-panel/pages/AgentHomePage";

const agentHomeSource = Bun.file(new URL("../pages/agent-panel/pages/AgentHomePage.tsx", import.meta.url));
const agentHomeCreationSource = Bun.file(new URL("../pages/agent-panel/pages/agent-home-creation.ts", import.meta.url));

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

  // 首页提交必须复用统一的实例进入流程，并携带实例 UID 导航，避免聊天页永久等待。
  test("创建后显式进入实例并导航到实例路由", async () => {
    const [pageSource, creationSource] = await Promise.all([agentHomeSource.text(), agentHomeCreationSource.text()]);

    expect(creationSource).toContain("resolveCreatedAgentChatTarget(agentConfigId");
    expect(pageSource).toContain('to: "/agent/chat/$agentId/$sessionId"');
    expect(pageSource).toContain("sessionId: outcome.instanceUid");
  });
});
