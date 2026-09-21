import { afterEach, beforeEach, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import { type MockChatSession, useMockChatSession } from "../chat/mocks/mock-chat-store";
import { MOCK_AGENT_ID, MOCK_RCS_SESSION_ID } from "../chat/mocks/mock-fixtures";
import { ChatInterface } from "../chat/shell/ChatInterface";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

/**
 * 内存 mock 驱动的契约测试。
 *
 * 覆盖范围是 mock 与真实组件的接缝，而不是 UI 结构：把 `useMockChatSession()` 的返回值
 * 按 demo 的消费方式展开给真实 `ChatInterface`，断言首屏形态、权限/问答应答、流式回放、
 * 取消与会话切换都能在零网络环境下跑通（mock 的 props 契约一旦漂移，本测试即失败）。
 *
 * 文案断言取「包内字典里的译文，字典尚未搬运时回落 key」，避免集成阶段补 i18n 后测试失真。
 */

const window = initializeHappyDomWindow(new Window());
/* biome-ignore lint/suspicious/noExplicitAny: 测试环境需要把 happy-dom 的 DOM 注入全局 */
(globalThis as any).window = window;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).document = window.document;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).navigator = window.navigator;
/* biome-ignore lint/suspicious/noExplicitAny: 同上（与 happy-dom 的 Blob/File 同源） */
(globalThis as any).FileReader = window.FileReader;
/* biome-ignore lint/suspicious/noExplicitAny: 同上（chat 组件依赖的浏览器全局） */
(globalThis as any).getComputedStyle = window.getComputedStyle.bind(window);
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).ResizeObserver = window.ResizeObserver;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).HTMLElement = window.HTMLElement;
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).requestAnimationFrame = window.requestAnimationFrame.bind(window);
/* biome-ignore lint/suspicious/noExplicitAny: 同上 */
(globalThis as any).cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
/* biome-ignore lint/suspicious/noExplicitAny: React 19 的 act 环境标记 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

let session: MockChatSession | null = null;
let container: HTMLDivElement;
let root: Root;

/** 与 demo 消费方式一致地渲染完整会话外壳。 */
function Harness() {
  const mock = useMockChatSession({ stepDelayMs: 0 });
  session = mock;
  return (
    <ChatInterface
      agentId={MOCK_AGENT_ID}
      rcsSessionId={MOCK_RCS_SESSION_ID}
      sessionState={mock.sessionState}
      chatState={mock.chatState}
      onSendPrompt={mock.sendPrompt}
      onCancel={mock.cancel}
      onCreateSession={mock.createSession}
      onRespondPermission={mock.respondPermission}
      onRespondQuestion={mock.respondQuestion}
      availableCommands={mock.availableCommands}
      availableModes={mock.availableModes}
      currentModeId={mock.currentModeId}
      onSetMode={mock.setSessionMode}
      supportsModeSelection={mock.supportsModeSelection}
      supportsImages={mock.supportsImages}
      modelName={mock.modelName}
      tokenUsage={mock.tokenUsage}
      periTasks={mock.periTasks}
      periTasksLoaded={mock.periTasksLoaded}
      connectionState={mock.connectionState}
      boundMcps={mock.boundMcps}
      projectEntries={mock.projectEntries}
      onOpenWorkspaceFile={() => {}}
      onNotice={() => {}}
      onStatsChange={() => {}}
    />
  );
}

/** 推进宏任务，驱动流式回放。 */
async function flush(times = 80): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function text(): string {
  return container.textContent ?? "";
}

beforeEach(() => {
  container = document.createElement("div") as HTMLDivElement;
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  session = null;
});

// 首屏样本就带待确认权限与待答问题：验证 mock 快照能驱动真实交互区渲染。
test("首屏渲染权限面板与状态面板", () => {
  act(() => root.render(<Harness />));
  // 待确认的 Bash 权限优先展示，工具入参可见
  expect(text()).toContain("bun run build:web");
  expect(session?.sessionState.status).toBe("waiting-user");
  expect(session?.chatState.permissions[0]?.status).toBe("pending");
});

// 权限优先于问答：应答后应露出问题面板，问题决议后交互区回落到状态面板。
test("应答权限后切到问答面板，应答后交互区清空", () => {
  act(() => root.render(<Harness />));
  expect(container.querySelectorAll(".chat-interaction-region").length).toBe(1);
  act(() => session?.respondPermission("perm-demo-1", "allow_once"));
  expect(session?.chatState.permissions[0]?.status).toBe("approved");
  // 轮到 AskUserQuestion 面板（时间线里的工具卡片同样含问题原文，故用面板容器判定）
  expect(container.querySelectorAll(".chat-interaction-region").length).toBe(1);
  expect(text()).toContain("补测试入口");

  act(() => session?.respondQuestion("question-demo-1", ["补测试入口"]));
  expect(session?.sessionState.pendingQuestions.size).toBe(0);
  expect(container.querySelectorAll(".chat-interaction-region").length).toBe(0);
  // 阻塞型交互清空后回落到状态面板（待办来自 plan 快照）
  expect(text()).toContain("把投影抽成可注入的 projectEntries");
});

// 流式回放：分片正文与工具卡片逐步到达，权限/问答作为暂停点被应答后继续到收尾。
test("sendPrompt 后分片回放、权限与问答可应答并推进到收尾", async () => {
  act(() => root.render(<Harness />));
  // 先清掉首屏样本里的交互栈，避免权限面板抢占问答面板
  act(() => session?.respondPermission("perm-demo-1", "allow_once"));
  act(() => session?.respondQuestion("question-demo-1", ["补测试入口"]));

  await act(async () => {
    await session?.sendPrompt([{ type: "text", text: "帮我跑一次构建" }]);
  });
  expect(session?.sessionState.loading).not.toBeNull();
  expect(text()).toContain("帮我跑一次构建");

  await flush();
  // 分片正文与工具调用已到达；脚本在权限请求处暂停
  expect(text()).toContain("我先把范围缩到这两块");
  expect(text()).toContain("packages/ui-components/web/chat/timeline/*.tsx");
  expect(session?.chatState.permissions.some((item) => item.id === "stream-perm-1")).toBe(true);
  expect(session?.sessionState.pendingQuestions.size).toBe(0);

  act(() => session?.respondPermission("stream-perm-1", "allow_once"));
  await flush();
  expect(text()).toContain("生产构建通过");
  expect(session?.sessionState.pendingQuestions.has("stream-question-1")).toBe(true);

  act(() => session?.respondQuestion("stream-question-1", ["标记完成"]));
  await flush();
  expect(text()).toContain("待办已全部完成");
  expect(session?.sessionState.loading).toBeNull();
  expect(session?.sessionState.canCancel).toBe(false);
});

// 取消：停止脚本回放并清除 loading/canCancel，与真实 turn 取消语义一致。
test("cancel 中止回放并清除 loading", async () => {
  act(() => root.render(<Harness />));
  await act(async () => {
    await session?.sendPrompt([{ type: "text", text: "跑一下构建" }]);
  });
  await flush(3);
  act(() => session?.cancel());
  await flush(5);
  expect(session?.sessionState.loading).toBeNull();
  expect(session?.sessionState.canCancel).toBe(false);
});

// 会话生命周期：新建会话得到空时间线，切回旧会话恢复其消息记录。
test("createSession / selectSession 切换会话", async () => {
  act(() => root.render(<Harness />));
  await act(async () => {
    await session?.createSession();
  });
  const sessions = session?.chatState.sessions ?? [];
  expect(sessions.length).toBe(4);
  expect(session?.chatState.activeSessionId).toBe(sessions[3]?.sessionId);
  expect(session?.sessionState.structuredMessages.length).toBe(0);

  act(() => session?.selectSession(MOCK_RCS_SESSION_ID));
  expect(session?.sessionState.structuredMessages.length).toBeGreaterThan(10);
});
