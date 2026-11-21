import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import * as events from "../api/file-events";
import * as files from "../api/fs";
import { FileTreeTab } from "../components/FileTreeTab";
import { MACHINE_NS, machineResources } from "../i18n";

const win = initializeHappyDomWindow(new Window({ url: "https://localhost" }));
const globals = globalThis as Record<string, unknown>;
const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Image",
  "Element",
  "Node",
  "Event",
  "MutationObserver",
  "ResizeObserver",
  "customElements",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
  "IS_REACT_ACT_ENVIRONMENT",
];
const originals = new Map(keys.map((key) => [key, globals[key]]));
const i18n = createInstance();
await i18n.init({
  lng: "zh",
  initAsync: false,
  resources: { zh: { [MACHINE_NS]: machineResources.zh, [UI_COMPONENTS_NS]: uiComponentsResources.zh } },
});
const treeSpy = spyOn(files.fsApi, "tree");
const revalidateSpy = spyOn(files, "revalidateWorkspaceTree");
const eventsSpy = spyOn(events, "openFileEventsConnection");
let handlers: events.FileEventsHandlers;
let root: Root;
let host: HTMLElement;
const response = (paths: string[]) => ({ success: true as const, data: { paths } });
const revalidated = (paths: string[]) => ({ status: "updated" as const, etag: "latest", tree: { paths } });
beforeEach(() => {
  const browser = win as unknown as Record<string, unknown>;
  for (const key of keys) globals[key] = browser[key];
  Object.assign(globals, {
    window: win,
    document: win.document,
    navigator: win.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  for (const key of ["requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"]) {
    const value = browser[key];
    if (typeof value === "function") globals[key] = value.bind(win);
  }
  Object.defineProperty(win.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 320 });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  treeSpy.mockReset();
  revalidateSpy.mockReset();
  eventsSpy.mockReset();
  treeSpy.mockResolvedValue(response(["initial.txt"]));
  revalidateSpy.mockResolvedValue(revalidated(["event.txt"]));
  eventsSpy.mockImplementation((_id, callbacks) => {
    handlers = callbacks;
    return { isOpen: () => true, close: () => {} };
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
afterAll(() => {
  treeSpy.mockRestore();
  revalidateSpy.mockRestore();
  eventsSpy.mockRestore();
  for (const [key, value] of originals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});
function render() {
  act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <FileTreeTab envId="env-a" onPreviewFile={() => {}} onReferenceFile={() => {}} onFilesChanged={() => {}} />
      </I18nextProvider>,
    ),
  );
}
async function flush() {
  await act(async () => {});
}
function shown(path: string) {
  return host.querySelector(`[data-tree-item][data-node-id="${path}"]`) !== null;
}

// 初始请求比事件回源晚返回时，不能把已经更新的文件树倒退到旧快照。
test("event tree supersedes a late initial tree response", async () => {
  const pending = Promise.withResolvers<ReturnType<typeof response>>();
  treeSpy.mockReturnValue(pending.promise);
  render();
  act(() => handlers.onOpen());
  await flush();
  expect(shown("event.txt")).toBe(true);
  pending.resolve(response(["stale.txt"]));
  await flush();
  expect(shown("event.txt")).toBe(true);
  expect(shown("stale.txt")).toBe(false);
});

// 手动刷新发起更新请求后，之前的事件回源必须被取消，不能覆盖刷新结果。
test("manual tree refresh supersedes a pending event revalidation", async () => {
  render();
  await flush();
  const pending = Promise.withResolvers<ReturnType<typeof revalidated>>();
  revalidateSpy.mockReturnValue(pending.promise);
  act(() => handlers.onOpen());
  treeSpy.mockResolvedValue(response(["fresh.txt"]));
  const refresh = host.querySelector<HTMLButtonElement>('button[aria-label="刷新"]');
  if (!refresh) throw new Error("refresh button missing");
  act(() => refresh.click());
  await flush();
  expect(shown("fresh.txt")).toBe(true);
  pending.resolve(revalidated(["stale-event.txt"]));
  await flush();
  expect(shown("fresh.txt")).toBe(true);
  expect(shown("stale-event.txt")).toBe(false);
});
