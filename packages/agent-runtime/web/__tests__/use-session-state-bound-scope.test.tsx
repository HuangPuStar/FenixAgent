// packages/agent-runtime/web/__tests__/use-session-state-bound-scope.test.tsx
// 投影换代首帧快照仍属于旧 Doc：boundScopeKey 必须滞后于 replacementVersion，
// 调用方才能丢弃旧 scope 的 replay/noReplay 信号，而不是直接喂给新 gate。

import { describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { useDocHubReplacementVersion } from "../hooks/use-doc-hub-replacement";
import { useSessionState } from "../hooks/use-session-state";
import { replaceDocHubUpdate } from "../yjs/doc-hub";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
const runtimeGlobal = globalThis as Record<string, unknown>;
runtimeGlobal.window = win;
runtimeGlobal.document = win.document;
runtimeGlobal.navigator = win.navigator;

function emptyUpdate(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

describe("useSessionState 换代绑定", () => {
  // 换代后到 rebind 前，版本已更新但快照仍绑定旧 scope；rebind 后才允许新 scope 使用该快照。
  test("换代首帧 boundScopeKey 滞后于 replacementVersion", () => {
    const key = "bound-scope-replacement";
    const frames: Array<{ version: number; boundScopeKey: string | null }> = [];
    function Probe() {
      const version = useDocHubReplacementVersion(key);
      const { boundScopeKey } = useSessionState(key);
      frames.push({ version, boundScopeKey });
      return null;
    }
    const container = win.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    act(() => root.render(createElement(Probe)));
    expect(frames.at(-1)).toEqual({ version: 0, boundScopeKey: `${key}:0` });

    act(() => {
      replaceDocHubUpdate(key, `chat:${key}`, "g1", emptyUpdate());
      replaceDocHubUpdate(key, `session:${key}`, "g1", emptyUpdate());
    });

    const versionOneFrames = frames.filter((frame) => frame.version === 1);
    // 必须先出现「新版本 + 旧绑定」的帧，证明旧快照不会冒充本次 scope 的信号。
    expect(versionOneFrames.some((frame) => frame.boundScopeKey === `${key}:0`)).toBe(true);
    expect(versionOneFrames.at(-1)).toEqual({ version: 1, boundScopeKey: `${key}:1` });
    act(() => root.unmount());
  });
});
