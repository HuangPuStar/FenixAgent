import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { useChatAreaSlots } from "@fenix/agent-runtime/web/agent-panel/chat-area-lifecycle";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { OrgSessionProvider } from "@fenix/web-runtime/contexts/org-session";
import { dispatchArtifactsPreviewFile } from "@fenix/web-runtime/lib/artifacts-preview-events";
import { EditorView } from "codemirror";
import { Window } from "happy-dom";
import { act, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";

const win = initializeHappyDomWindow(new Window({ url: "https://localhost/ctrl/agent/chat/env/instance" }));
const globals = globalThis as Record<string, unknown>;
const keys = [
  "window",
  "history",
  "location",
  "scrollTo",
  "document",
  "navigator",
  "localStorage",
  "IS_REACT_ACT_ENVIRONMENT",
  "MutationObserver",
  "HTMLElement",
  "HTMLInputElement",
  "Node",
  "NodeFilter",
  "Text",
  "Element",
  "DocumentFragment",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "ResizeObserver",
  "DOMRect",
  "customElements",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "WebSocket",
  "IntersectionObserver",
];
const originals = new Map(keys.map((key) => [key, globals[key]]));
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLElement | undefined;
let Workspace: typeof import("../pages/agent-panel/chat-workspace-artifacts").ChatWorkspaceArtifacts;

async function until(check: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline)
    await act(async () => {
      await Bun.sleep(25);
    });
  expect(check()).toBe(true);
}
async function startEditing() {
  const edit = () => host?.querySelector<HTMLButtonElement>('button[aria-label="Edit"]');
  await until(() => Boolean(edit()));
  await act(async () => edit()?.click());
}
function Probe() {
  const { activeRestartVersion } = useChatAreaSlots("env", "instance", "org:user");
  const hostProps = { agentId: "env", sessionId: "instance", agentRestartVersion: activeRestartVersion };
  return (
    <OrgSessionProvider value={{ organizationId: "org", userId: "user", isOwner: true, pending: false }}>
      <Suspense fallback={<p>Loading</p>}>
        <Workspace {...hostProps}>
          <p>Chat</p>
        </Workspace>
      </Suspense>
    </OrgSessionProvider>
  );
}
afterEach(async () => {
  if (root) act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
  globalThis.fetch = originalFetch;
  await win.happyDOM.abort();
});
afterAll(() => {
  for (const [key, value] of originals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

beforeEach(async () => {
  const browser = win as unknown as Record<string, unknown>;
  for (const key of keys) globals[key] = browser[key];
  Object.assign(globals, {
    window: win,
    document: win.document,
    navigator: win.navigator,
    localStorage: win.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "scrollTo"]) {
    const value = browser[key];
    if (typeof value === "function") globals[key] = value.bind(win);
  }
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  globals.IntersectionObserver = Observer;
  browser.IntersectionObserver = Observer;
  globals.WebSocket = class {
    static OPEN = 1;
    readyState = 0;
    onopen = null;
    onmessage = null;
    onclose = null;
    close() {}
    send() {}
  };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://localhost");
      const path = url.pathname.split("/fs/")[1];
      const data = url.pathname.endsWith("file-editing-capabilities")
        ? {
            text: { enabled: true },
            textMaxBytes: 2097152,
            office: { enabled: false, extensions: [], maxBytes: 96468992 },
          }
        : path === "tree"
          ? { paths: ["user/draft.txt"], mtimes: {}, sizes: {} }
          : path
            ? { path, name: "draft.txt", content: "original", size: 8, version: "v1", encoding: "utf8" }
            : { id: "env", agentConfigId: null };
      return Response.json({ success: true, data });
    },
    { preconnect: originalFetch.preconnect },
  );
  ({ ChatWorkspaceArtifacts: Workspace } = await import("../pages/agent-panel/chat-workspace-artifacts"));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Probe />));
  await until(() => Boolean(host?.querySelector(".artifacts-workspace")));
});

// 同一环境的 Agent 重连只重置聊天进程，真实工件面板中的未保存文件必须保留原编辑器和草稿。
test("Agent reconnect preserves the host artifacts editor and its unsaved draft", async () => {
  act(() => dispatchArtifactsPreviewFile("env", "user/draft.txt"));
  await startEditing();
  await until(() => Boolean(host?.querySelector(".cm-editor")));
  const editor = host?.querySelector(".cm-editor");
  const view = EditorView.findFromDOM(editor as HTMLElement);
  if (!view) throw new Error("Missing CodeMirror view");
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "retained host draft" } }));
  act(() =>
    window.dispatchEvent(
      new window.CustomEvent("agent:reconnect", { detail: { envId: "env", instanceUid: "instance" } }),
    ),
  );
  await act(async () => {
    await Bun.sleep(50);
  });
  expect(host?.querySelector(".cm-editor")).toBe(editor);
  expect(host?.querySelector(".cm-content")?.textContent).toBe("retained host draft");
});

// 面板关闭只隐藏宿主；重新展开必须恢复当前文件，不能等待用户切换文件才重新加载。
test("reopening the sidebar reloads its selected text file without switching tabs", async () => {
  await act(async () => dispatchArtifactsPreviewFile("env", "user/draft.txt"));
  await startEditing();
  await until(() => Boolean(host?.querySelector(".cm-editor")));
  expect(host?.querySelector(".cm-content")?.textContent).toBe("original");
  await act(async () => host?.querySelector<HTMLButtonElement>('button[aria-label="Close right workspace"]')?.click());
  await until(() => Boolean(host?.querySelector('button[aria-label="Show artifacts panel"]')));
  await act(async () => host?.querySelector<HTMLButtonElement>('button[aria-label="Show artifacts panel"]')?.click());
  await until(() => Boolean(host?.querySelector(".cm-editor")), 2000);
  expect(host?.querySelector(".cm-content")?.textContent).toBe("original");
});
