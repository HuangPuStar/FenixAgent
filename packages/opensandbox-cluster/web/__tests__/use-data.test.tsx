import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ClusterClient } from "../api/client";
import type { Allocation } from "../api/types";
import { useData } from "../use-data";
import { useSandboxStatus } from "../use-sandbox-status";

const browser = new Window();
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, value] of saved)
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
});
function fixture() {
  const pending: ((response: Response) => void)[] = [];
  const client = new ClusterClient(
    () => "key",
    () => {},
    async () => new Promise<Response>((resolve) => pending.push(resolve)),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function View({ path, version }: { path: string; version: number }) {
    const result = useData<{ id: string }>(client, path, version);
    return (
      <>
        {result.loading && <p>loading</p>}
        {result.data && <button>{result.data.id}</button>}
        {result.error && <p role="alert">{result.error}</p>}
      </>
    );
  }
  const render = async (path: string, version: number) => {
    await act(async () => {
      root.render(<View path={path} version={version} />);
    });
  };
  const respond = async (response: Response) => {
    await act(async () => {
      pending.shift()!(response);
    });
  };
  const close = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, render, respond, close };
}
// 后台刷新期间保留同一 DOM 行，加载和失败均不清空正在浏览的内容。
test("background refresh preserves rows through pending and failed reads", async () => {
  const f = fixture();
  try {
    await f.render("/a", 0);
    await f.respond(Response.json({ id: "first" }));
    const row = f.container.querySelector("button");
    await f.render("/a", 1);
    expect(f.container.querySelector("button")).toBe(row);
    expect(f.container.textContent).not.toContain("loading");
    await f.respond(Response.json({ id: "updated" }));
    expect(f.container.querySelector("button")).toBe(row);
    expect(row?.textContent).toBe("updated");
    await f.render("/a", 2);
    await f.respond(Response.json({ error: { message: "temporarily unavailable" } }, { status: 503 }));
    expect(f.container.querySelector("button")).toBe(row);
    expect(f.container.querySelector("[role=alert]")?.textContent).toBe("temporarily unavailable");
  } finally {
    await f.close();
  }
});
// 切换筛选时移除旧数据，迟到的旧请求不能覆盖新筛选结果。
test("filter changes ignore obsolete reads", async () => {
  const f = fixture();
  try {
    await f.render("/a", 0);
    await f.respond(Response.json({ id: "a" }));
    await f.render("/a", 1);
    await f.render("/b", 1);
    expect(f.container.querySelector("button")).toBeNull();
    await f.respond(Response.json({ id: "stale" }));
    expect(f.container.querySelector("button")).toBeNull();
    await f.respond(Response.json({ id: "b" }));
    expect(f.container.querySelector("button")?.textContent).toBe("b");
  } finally {
    await f.close();
  }
});

function allocation(id: string): Allocation {
  return {
    sandbox_id: id,
    pool_id: "p",
    server_id: "n",
    allocation_mode: "count",
    allocation_etag: id,
    state: "active",
    provider_sandbox_id: id,
    expires_at: null,
    proxy_url: `/proxy/${id}`,
    resources: null,
    created_at: 0,
  };
}
function statusFixture() {
  const pending: { path: string; resolve: (response: Response) => void }[] = [];
  const client = new ClusterClient(
    () => "key",
    () => {},
    async (path) => new Promise<Response>((resolve) => pending.push({ path, resolve })),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function View({ items, version }: { items: Allocation[]; version: number }) {
    const status = useSandboxStatus(client, items, version);
    return (
      <>
        {items.map((item) => (
          <button key={item.sandbox_id}>
            {item.sandbox_id}:{status(item).state}:{status(item).error}
          </button>
        ))}
      </>
    );
  }
  return {
    container,
    pending,
    render: async (items: Allocation[], version = 0) => {
      await act(async () => root.render(<View items={items} version={version} />));
    },
    respond: async (index: number, response: Response) => {
      await act(async () => pending[index].resolve(response));
    },
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
// 查询真实状态时最多四个并发，避免分页列表同时压满节点。
test("native status lookup caps concurrent reads at four", async () => {
  const f = statusFixture();
  try {
    await f.render(Array.from({ length: 6 }, (_, i) => allocation(String(i))));
    expect(f.pending).toHaveLength(4);
    await f.respond(0, Response.json({ status: { state: "Running" } }));
    expect(f.pending).toHaveLength(5);
    expect(f.container.textContent).toContain("0:Running");
    await f.render(Array.from({ length: 6 }, (_, i) => allocation(String(i))));
    expect(f.pending).toHaveLength(5);
    await f.respond(1, Response.json({ status: { state: "Paused" } }));
    expect(f.pending).toHaveLength(6);
    for (const i of [2, 3, 4, 5]) await f.respond(i, Response.json({ status: { state: "Running" } }));
    expect(f.container.textContent).toContain("1:Paused");
  } finally {
    await f.close();
  }
});
// 刷新保留上次状态，错误可见，恢复成功后清除错误并更新运行状态。
test("native state refresh preserves content and recovers from query failure", async () => {
  const f = statusFixture();
  try {
    await f.render([allocation("a")]);
    await f.respond(0, Response.json({ status: { state: "Running" } }));
    const row = f.container.querySelector("button");
    await f.render([allocation("a")], 1);
    expect(f.container.textContent).toContain("Running");
    await f.respond(1, Response.json({ error: { message: "offline" } }, { status: 503 }));
    expect(f.container.querySelector("button")).toBe(row);
    expect(f.container.textContent).toContain("Running:offline");
    await f.render([allocation("a")], 2);
    await f.respond(2, Response.json({ status: { state: "Paused" } }));
    expect(f.container.textContent).toContain("Paused");
    expect(f.container.textContent).not.toContain("offline");
  } finally {
    await f.close();
  }
});
// 旧分页的迟到结果不能覆盖新分页，远端 404 明确显示已销毁。
test("native status ignores obsolete reads and reports confirmed absence", async () => {
  const f = statusFixture();
  try {
    await f.render([allocation("a")]);
    await f.render([allocation("b")]);
    await f.respond(1, new Response(null, { status: 404 }));
    await f.respond(0, Response.json({ status: { state: "Running" } }));
    expect(f.container.textContent).toContain("b:已销毁");
    expect(f.container.textContent).not.toContain("Running");
  } finally {
    await f.close();
  }
});
