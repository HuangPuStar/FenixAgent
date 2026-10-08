import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type ComposerState, useComposerState } from "../chat/composer/composer-state";

const window = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
globals.window = window;
globals.document = window.document;
globals.navigator = window.navigator;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let state: ComposerState;

function ComposerStateHarness() {
  state = useComposerState({});
  return null;
}

beforeEach(() => {
  root = createRoot(window.document.createElement("div") as unknown as HTMLElement);
  act(() => root.render(<ComposerStateHarness />));
});

afterEach(() => {
  act(() => root.unmount());
});

describe("附件自动引用草稿归属", () => {
  // 移除前一个附件后，后一个引用的位置必须同步移动，全部移除后草稿恢复为空。
  test("连续移除多个附件不会残留自动引用", () => {
    act(() => {
      state.addAttachments([
        { name: "a.txt", path: "a.txt" },
        { name: "b.txt", path: "b.txt" },
      ]);
    });
    expect(state.text).toBe("@./a.txt @./b.txt ");
    act(() => state.removeAttachment("a.txt"));
    expect(state.text).toBe("@./b.txt ");
    act(() => state.removeAttachment("b.txt"));
    expect(state.text).toBe("");
    expect(state.attachments).toEqual([]);
  });

  // 用户在引用前后继续编辑时应跟踪自动引用位置，但移除附件不能删掉新增正文。
  test("编辑引用外正文后仅删除自动引用", () => {
    act(() => state.addAttachments([{ name: "a.txt", path: "a.txt" }]));
    act(() => state.setText((text) => `前缀 ${text}`));
    act(() => state.setText((text) => `${text}后缀`));
    act(() => state.removeAttachment("a.txt"));
    expect(state.text).toBe("前缀 后缀");
    expect(state.attachments).toEqual([]);
  });

  // 自动引用被用户改写后转为用户正文，删除原附件卡片不能清理改写后的文本。
  test("用户改写的引用保持不变", () => {
    act(() => state.addAttachments([{ name: "a.txt", path: "a.txt" }]));
    act(() => state.setText("@./user-file.txt "));
    act(() => state.removeAttachment("a.txt"));
    expect(state.text).toBe("@./user-file.txt ");
    expect(state.attachments).toEqual([]);
  });

  // 同一批次重复引用已入队附件不得重复自动插入，移除后重新添加仍只生成一份。
  test("重复添加和重新添加不会叠加自动引用", () => {
    const file = { name: "a.txt", path: "a.txt" };
    act(() => {
      state.addAttachments([file]);
      state.addAttachments([file]);
    });
    expect(state.attachments).toEqual([file]);
    expect(state.text).toBe("@./a.txt ");
    act(() => {
      state.removeAttachment(file.path);
      state.addAttachments([file]);
    });
    expect(state.attachments).toEqual([file]);
    expect(state.text).toBe("@./a.txt ");
  });
});
