import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { OrgMemberCandidate } from "../api/organizations";
import i18n from "../i18n";
import { initializeHappyDomWindow } from "./happy-dom-window";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const win = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
const originalGlobals = new Map(
  ["window", "document", "navigator", "HTMLElement", "Element", "Node", "CustomEvent"].map((key) => [
    key,
    globals[key],
  ]),
);
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.HTMLElement = win.HTMLElement;
globals.Element = win.Element;
globals.Node = win.Node;
globals.CustomEvent = win.CustomEvent;

const candidate: OrgMemberCandidate = {
  id: "user-2",
  name: "2222",
  email: "admin1@test.com",
  isMember: false,
};

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  win.document.body.replaceChildren();
});
afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

describe("添加组织成员弹窗", () => {
  // 点击搜索结果必须触发候选人选择，避免添加按钮一直停留在禁用状态。
  test("点击候选用户触发添加回调", async () => {
    const { MemberCandidateButton } = await import("../pages/agent-panel/pages/agent-organizations-dialogs");
    const selected: OrgMemberCandidate[] = [];
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    root = createRoot(container as unknown as HTMLElement);
    await act(async () =>
      root?.render(
        <I18nextProvider i18n={i18n}>
          <MemberCandidateButton candidate={candidate} selected={false} onAdd={(item) => selected.push(item)} />
        </I18nextProvider>,
      ),
    );

    const button = container.querySelector("button") as unknown as HTMLButtonElement | null;
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(selected).toEqual([candidate]);
  });

  // 已在组织内的用户不可重复选择。
  test("已有成员候选按钮保持禁用", async () => {
    const { MemberCandidateButton } = await import("../pages/agent-panel/pages/agent-organizations-dialogs");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    root = createRoot(container as unknown as HTMLElement);
    await act(async () =>
      root?.render(
        <I18nextProvider i18n={i18n}>
          <MemberCandidateButton
            candidate={{ ...candidate, isMember: true }}
            selected={false}
            onAdd={() => undefined}
          />
        </I18nextProvider>,
      ),
    );

    const button = container.querySelector("button") as unknown as HTMLButtonElement | null;
    expect(button?.disabled).toBe(true);
  });
});
