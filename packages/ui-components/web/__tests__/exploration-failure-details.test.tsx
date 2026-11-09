import { expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

if (process.env.FENIX_EXPLORATION_DETAILS_CHILD !== "1") {
  // 独立进程保证 Radix 在 DOM 装配后首载，覆盖真实详情入口。
  test("探索失败的记忆与嵌套工具详情交互", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, FENIX_EXPLORATION_DETAILS_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  });
} else {
  const win = initializeHappyDomWindow(new Window());
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    Node: win.Node,
    NodeFilter: win.NodeFilter,
    MutationObserver: win.MutationObserver,
    CustomEvent: win.CustomEvent,
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    getComputedStyle: win.getComputedStyle.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { HindsightToolCard } = await import("../chat/timeline/HindsightToolCard");
  const { ToolCallGroup } = await import("../chat/timeline/ToolCallGroup");
  const { SubAgentPanel } = await import("../chat/timeline/SubAgentPanel");
  const { SubAgentToolCallGroupContext } = await import("../chat/timeline/sub-agent-tool-call-context");
  const i18n = createInstance();
  await i18n.init({ lng: "en", initAsync: false, resources: { en: { [UI_COMPONENTS_NS]: en } } });

  // 仅有 PublicError 的记忆调用仍须有详情，默认不展示错误正文。
  test("主动打开记忆详情可查真实失败原因", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <I18nextProvider i18n={i18n}>
            <HindsightToolCard
              tool={{
                id: "memory",
                title: "hindsight_recall",
                status: "error",
                publicError: { type: "INTERNAL.UNCLASSIFIED", id: "memory-error", message: "classified error" },
              }}
            />
          </I18nextProvider>,
        ),
      );
      expect(host.textContent).not.toContain("unclassified system error");
      await act(async () => host.querySelector("button")?.click());
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        "An unclassified system error occurred.",
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  // 子 Agent 展开其轨迹后仍复用同一中性工具行，错误原因只在二次主动展开后出现。
  test("嵌套工具失败默认中性，展开工具可查原因", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <I18nextProvider i18n={i18n}>
            <SubAgentToolCallGroupContext.Provider value={(entries) => <ToolCallGroup entries={entries} />}>
              <SubAgentPanel
                entries={[
                  {
                    type: "tool_call",
                    toolCall: {
                      id: "nested",
                      title: "Bash",
                      status: "error",
                      rawOutput: { error: "nested diagnostic" },
                    },
                  },
                ]}
              />
            </SubAgentToolCallGroupContext.Provider>
          </I18nextProvider>,
        ),
      );
      await act(async () => host.querySelector("button")?.click());
      expect(host.textContent).not.toContain("nested diagnostic");
      const toggle = host.querySelector<HTMLButtonElement>('[data-slot="chat-tool-call-expand"]');
      expect(toggle).not.toBeNull();
      await act(async () => toggle?.click());
      expect(host.textContent).toContain("nested diagnostic");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
}
