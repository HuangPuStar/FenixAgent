import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import type { ComposerExternalEvent, ComposerExternalSubscribe } from "../chat/composer/composer-effects";
import { type MockChatSession, useMockChatSession } from "../chat/mocks/mock-chat-store";
import { MOCK_AGENT_ID, MOCK_RCS_SESSION_ID } from "../chat/mocks/mock-fixtures";
import { ACPMain } from "../chat/shell/ACPMain";
import { ChatInterface } from "../chat/shell/ChatInterface";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

/**
 * Chat 外壳（`web/chat/shell/`）的接线测试：只覆盖「端口与包内环路是否真的通了」，
 * 不覆盖 UI 结构。
 *
 * 覆盖三类接缝，各自对应一种会静默失效的失败模式（点击无反应、无报错）：
 * 1. 包内输入岛环路 — 空状态建议提示词由 `ChatView` 产生、`ChatComposer` 消费，
 *    源实现经 window 事件回环；纯化后必须由 `useComposerInputBridge` 在包内闭合。
 * 2. 合并订阅 — 宿主注入的 `subscribeExternal` 不能被包内环路吞掉（文件树引用仍要生效）。
 * 3. `ACPMain` 的端口透传 — 缺一行透传时宿主注入的回调被丢弃而类型检查仍然通过。
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
/* biome-ignore lint/suspicious/noExplicitAny: 同上（streamdown 的 diff 组件按 `customElements.get` 判定自定义元素） */
(globalThis as any).customElements = window.customElements;
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

/** 渲染完整 ChatInterface；`subscribeExternal` 按需注入，缺省时不注入任何宿主订阅。 */
function ChatHarness({ subscribeExternal }: { subscribeExternal?: ComposerExternalSubscribe }) {
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
      subscribeExternal={subscribeExternal}
      onNotice={() => {}}
      onStatsChange={() => {}}
    />
  );
}

/** 只读模式的 ACPMain（不渲染顶部会话头与输入岛，聚焦消息区的端口透传）。 */
function AcpMainHarness({ onOpenWorkspaceFile }: { onOpenWorkspaceFile: (envId: string, path: string) => void }) {
  const mock = useMockChatSession({ stepDelayMs: 0 });
  session = mock;
  return (
    <ACPMain
      agentId={MOCK_AGENT_ID}
      rcsSessionId={MOCK_RCS_SESSION_ID}
      readonly={true}
      chatState={mock.chatState}
      sessionState={mock.sessionState}
      connectionState={mock.connectionState}
      onSendPrompt={mock.sendPrompt}
      onCancel={mock.cancel}
      onCreateSession={mock.createSession}
      onLoadSession={() => {}}
      onResumeSession={() => {}}
      onRenameSession={() => {}}
      onDeleteSession={() => {}}
      onRespondPermission={mock.respondPermission}
      onRespondQuestion={mock.respondQuestion}
      // 与 mock 的能力集（loadSession/resumeSession 均支持）一致，避免 bootstrap 走进
      // 「不支持加载会话」的抛错分支
      supportsLoadSession={true}
      availableCommands={mock.availableCommands}
      projectEntries={mock.projectEntries}
      onOpenWorkspaceFile={onOpenWorkspaceFile}
      onNotice={() => {}}
    />
  );
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

/** 切到新建的空会话，露出空状态与建议提示词。 */
async function enterEmptySession(): Promise<void> {
  await act(async () => {
    await session?.createSession();
  });
  expect(session?.sessionState.structuredMessages.length).toBe(0);
}

/** 读第一条空状态建议提示词的文案，并返回其按钮。 */
function firstSuggestion(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('[data-slot="chat-empty-suggestions"] button');
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

describe("Chat 外壳接线", () => {
  // 包内环路：不注入任何宿主订阅时，空状态建议提示词仍要落到输入岛草稿。
  test("空状态建议提示词经包内环路写入草稿", async () => {
    act(() => root.render(<ChatHarness />));
    await enterEmptySession();

    const suggestion = firstSuggestion();
    act(() => suggestion.click());
    expect(container.querySelector("textarea")?.value).toBe(suggestion.textContent?.trim());
  });

  // 合并订阅：宿主注入的来源与包内事件共用一条通道，两者都要到达输入岛。
  test("宿主外部事件与包内事件共用同一通道", async () => {
    let emitFromHost: ((event: ComposerExternalEvent) => void) | undefined;
    const subscribeExternal: ComposerExternalSubscribe = (handler) => {
      emitFromHost = handler;
      return () => {
        emitFromHost = undefined;
      };
    };
    act(() => root.render(<ChatHarness subscribeExternal={subscribeExternal} />));
    await enterEmptySession();

    // 宿主来源（文件树引用，源实现为 window `file-tree:reference`）
    act(() => emitFromHost?.({ type: "file-reference", file: { name: "index.ts", path: "src/index.ts" } }));
    expect(container.querySelector("textarea")?.value).toBe("@./src/index.ts ");

    // 包内来源（建议提示词）仍可通过同一通道写入草稿
    const suggestion = firstSuggestion();
    act(() => suggestion.click());
    expect(container.querySelector("textarea")?.value).toBe(suggestion.textContent?.trim());
  });

  // ACPMain 必须把 onOpenWorkspaceFile 透传到消息区：用户消息里的 @./path 可点击打开。
  test("ACPMain 透传 onOpenWorkspaceFile", () => {
    const opened: Array<[string, string]> = [];
    act(() => root.render(<AcpMainHarness onOpenWorkspaceFile={(envId, path) => opened.push([envId, path])} />));

    const fileButton = container.querySelector<HTMLButtonElement>("[data-file-attachment]");
    expect(fileButton?.getAttribute("data-file-attachment")).toBe("src/lib/context-queue.ts");
    act(() => fileButton?.click());
    expect(opened).toEqual([[MOCK_AGENT_ID, "src/lib/context-queue.ts"]]);
  });
});
