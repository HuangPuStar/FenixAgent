import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFileTreeEvents } from "../hooks/use-file-tree-events";

let win = initializeHappyDomWindow(new Window({ url: "https://localhost" }));
const globals = globalThis as Record<string, unknown>;
const keys = ["window", "document", "localStorage", "WebSocket", "IS_REACT_ACT_ENVIRONMENT"];
const originalGlobals = new Map(keys.map((key) => [key, globals[key]]));
const originalFetch = globalThis.fetch;
let sockets: FakeSocket[];
let applied: string[][];
let changes: Array<{ kind: "paths" | "invalidate-all"; paths: readonly string[] }>;
let errors: unknown[];
let root: Root;
let reads: Array<{ url: string; signal?: AbortSignal | null }>;
let fetchTree: (input: string, init?: RequestInit) => Promise<Response>;
class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(_url: string) {
    sockets.push(this);
  }
  send(_payload: string) {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  frame(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
const applyTree = (paths: string[]) => {
  applied.push(paths);
};
const unavailable = (error: unknown) => {
  errors.push(error);
};
const changed = (change: { kind: "paths" | "invalidate-all"; paths: readonly string[] }) => {
  changes.push(change);
};
function Probe({ envId }: { envId: string }) {
  useFileTreeEvents({ envId, applyTree, onUnavailable: unavailable, onFileChanged: changed });
  return null;
}
function render(envId = "env-a") {
  act(() => root.render(<Probe envId={envId} />));
}
async function flush() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 10));
  });
}
function tree(paths: string[], etag = "v1") {
  return Response.json({ success: true, data: { paths } }, { headers: { etag } });
}
function deferred<T>() {
  return Promise.withResolvers<T>();
}
beforeEach(() => {
  win = initializeHappyDomWindow(new Window({ url: "https://localhost" }));
  Object.assign(globals, {
    window: win,
    document: win.document,
    localStorage: win.localStorage,
    WebSocket: FakeSocket,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  root = createRoot(document.createElement("div"));
  sockets = [];
  applied = [];
  changes = [];
  errors = [];
  reads = [];
  fetchTree = async () => tree(["initial.txt"]);
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      reads.push({ url: String(input), signal: init?.signal });
      return fetchTree(String(input), init);
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(async () => {
  act(() => root.unmount());
  await win.happyDOM.abort();
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

// 路径事件必须同时传递重命名两端，全量失效与其他环境不能混为普通路径更新。
test("file frames include rename destination and preserve invalidation scope", async () => {
  render();
  act(() => sockets[0]?.open());
  await flush();
  act(() => {
    sockets[0]?.frame({ type: "file_changed", environment_id: "env-b", path: "ignored.txt" });
    sockets[0]?.frame({ type: "file_changed", environment_id: "env-a", path: "old.txt", to: "new.txt" });
    sockets[0]?.frame({
      type: "file_changed_batch",
      environment_id: "env-a",
      changes: [{ path: "a.txt", to: "b.txt" }, { path: "c.txt" }],
    });
    sockets[0]?.frame({ type: "invalidate_all", environment_id: "env-a" });
  });
  expect(changes).toEqual([
    { kind: "invalidate-all", paths: [] },
    { kind: "paths", paths: ["old.txt", "new.txt"] },
    { kind: "paths", paths: ["a.txt", "b.txt", "c.txt"] },
    { kind: "invalidate-all", paths: [] },
  ]);
});

// 同环境强制重取可并发，旧响应不能覆盖较新的树和 ETag。
test("latest forced tree response wins and cancels the older request", async () => {
  const older = deferred<Response>();
  const newer = deferred<Response>();
  fetchTree = async () => (reads.length === 1 ? older.promise : newer.promise);
  render();
  act(() => sockets[0]?.open());
  act(() => document.dispatchEvent(new win.Event("visibilitychange") as unknown as Event));
  await flush();
  expect(changes).toHaveLength(2);
  expect(reads).toHaveLength(2);
  newer.resolve(tree(["newer.txt"], "v2"));
  await flush();
  older.resolve(tree(["older.txt"], "v1"));
  await flush();
  expect(applied).toEqual([["newer.txt"]]);
  expect(reads[0]?.signal?.aborted).toBe(true);
});

// 重连和恢复可见时需全量失效，旧连接的迟到帧不能进入新连接。
test("visibility reconnect invalidates buffers and ignores retired socket frames", async () => {
  render();
  act(() => sockets[0]?.open());
  await flush();
  act(() => sockets[0]?.close());
  act(() => document.dispatchEvent(new win.Event("visibilitychange") as unknown as Event));
  expect(sockets).toHaveLength(2);
  act(() => {
    sockets[1]?.open();
    sockets[0]?.frame({ type: "file_changed", environment_id: "env-a", path: "retired.txt" });
  });
  await flush();
  expect(changes.every((change) => change.kind === "invalidate-all")).toBe(true);
  expect(changes.length).toBeGreaterThanOrEqual(3);
});

// 离开后重新进入同一环境仍是新代次，旧连接和旧读取都须失效。
test("same environment reentry ignores previous socket and read generation", async () => {
  const pending = deferred<Response>();
  fetchTree = async () => (reads.length === 1 ? pending.promise : tree(["reopened.txt"]));
  render();
  act(() => sockets[0]?.open());
  render("env-b");
  render("env-a");
  act(() => sockets[2]?.open());
  await flush();
  pending.resolve(tree(["stale.txt"]));
  act(() => sockets[0]?.frame({ type: "file_changed", environment_id: "env-a", path: "stale.txt" }));
  await flush();
  expect(applied).toEqual([["reopened.txt"]]);
  expect(changes.some((change) => change.paths.includes("stale.txt"))).toBe(false);
  expect(reads[0]?.signal?.aborted).toBe(true);
  expect(errors).toEqual([]);
});

// 首次连接后的路径通知也必须及时刷新，不能被三十秒节流窗口丢弃。
test("path notification shortly after connect refreshes the tree", async () => {
  let paths = ["initial.txt"];
  fetchTree = async () => tree(paths);
  render();
  act(() => sockets[0]?.open());
  await flush();
  paths = ["created.txt"];
  act(() => sockets[0]?.frame({ type: "file_changed", environment_id: "env-a", path: "created.txt" }));
  await act(async () => {
    await new Promise((done) => setTimeout(done, 550));
  });
  expect(applied.at(-1)).toEqual(["created.txt"]);
  expect(reads).toHaveLength(2);
});
