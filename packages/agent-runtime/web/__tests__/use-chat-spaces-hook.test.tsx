// 会话分组 hook 的数据流测试：空 instanceUid 不发请求、列表随实例切换重取且不透出旧实例数据、
// 变更失败向调用方传播、成功则重取列表（服务端权威）、列表失败经 spacesError 透出且不跨实例继承。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { ApiError } from "@fenix/web-runtime/api/request";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type UseChatSpacesResult, useChatSpaces } from "../hooks/use-chat-spaces";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 设置最小 DOM 环境（react-dom/client 加载时需要 window；仅在本文件作用域内生效）
const win = initializeHappyDomWindow(new Window());
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;

const fetchCalls: Array<[string, RequestInit]> = [];

// `globalThis.fetch` 是进程级全局：装桩后必须还原，避免其后运行的服务端用例收到这里的桩响应
let originalFetch: typeof globalThis.fetch;

/** 当前用例的响应工厂，默认给空分组列表；需要失败或特异载荷的用例自行替换 */
let respond: (call: { url: string; init: RequestInit }) => Response | Promise<Response> = () =>
  jsonResponse({ success: true, data: { spaces: [] } });

/** 构造 JSON 响应（request 层按 Content-Type 判定解析路径） */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

/** 后端视图形状的分组载荷（snake_case 由 client 归一） */
function spacePayload(id: string, instanceUid: string, sessionIds: string[] = []) {
  return { id, instance_uid: instanceUid, name: id, session_ids: sessionIds };
}

beforeEach(() => {
  fetchCalls.length = 0;
  respond = () => jsonResponse({ success: true, data: { spaces: [] } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock((url: string, init: RequestInit) => {
    fetchCalls.push([url, init]);
    return Promise.resolve(respond({ url, init }));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** 渲染真实 hook 的探针组件，返回最新快照与重渲染 / 卸载控制 */
function createHarness() {
  const latest = { value: null as UseChatSpacesResult | null };
  function Probe({ instanceUid }: { instanceUid: string | null | undefined }) {
    latest.value = useChatSpaces({ instanceUid });
    return null;
  }
  const container = win.document.createElement("div");
  const root: Root = createRoot(container as unknown as HTMLElement);
  return {
    /** 当前渲染的快照（未渲染时直接失败，避免用例里到处写非空断言） */
    snapshot: (): UseChatSpacesResult => {
      if (!latest.value) throw new Error("hook 尚未渲染出快照");
      return latest.value;
    },
    render: (instanceUid: string | null | undefined) =>
      act(() => {
        root.render(createElement(Probe, { instanceUid }));
      }),
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

/** 等待 useRequest 落地：响应解析 → setState → 重渲染（ahooks 内部是微任务 + React 调度） */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useChatSpaces", () => {
  // 连续归属动作必须按发起顺序落库，首个失败也不能阻断用户后续移出。
  test("同实例写串行，失败后仍发送下一次动作", async () => {
    let settle: (response: Response) => void = () => {};
    respond = ({ init }) =>
      init.method === "PUT"
        ? new Promise((resolve) => {
            settle = resolve;
          })
        : jsonResponse({ success: true, data: { spaces: [] } });
    const harness = createHarness();
    harness.render("ins_1");
    await flush();
    const first = harness
      .snapshot()
      .assignSession("space_1", "ses_a")
      .catch((error: unknown) => error);
    const second = harness.snapshot().unassignSession("ses_a");
    expect(fetchCalls.map(([, init]) => init.method)).toEqual(["GET", "PUT"]);
    await act(async () => {
      settle(jsonResponse({ success: false, error: { code: "conflict", message: "rejected" } }));
      expect(await first).toBeInstanceOf(ApiError);
      await second;
    });
    expect(fetchCalls.map(([, init]) => init.method)).toEqual(["GET", "PUT", "DELETE", "GET"]);
    harness.unmount();
  });

  // A 实例在途写不应阻塞 B 实例，也不得把迟到的 A 列表展示到 B。
  test("跨实例写互不阻塞且旧响应不污染当前实例", async () => {
    let settle: (response: Response) => void = () => {};
    respond = ({ url, init }) =>
      init.method === "PUT"
        ? new Promise((resolve) => {
            settle = resolve;
          })
        : jsonResponse({ success: true, data: { spaces: [spacePayload(url.includes("ins_2") ? "b" : "a", "")] } });
    const harness = createHarness();
    harness.render("ins_1");
    await flush();
    const pending = harness.snapshot().assignSession("space_1", "ses_a");
    harness.render("ins_2");
    await flush();
    await act(async () => harness.snapshot().unassignSession("ses_b"));
    expect(fetchCalls.some(([url, init]) => url.includes("ins_2") && init.method === "DELETE")).toBe(true);
    await act(async () => {
      settle(jsonResponse({ success: true, data: {} }));
      await pending;
    });
    await flush();
    expect(harness.snapshot().spaces.map((space) => space.id)).toEqual(["b"]);
    harness.unmount();
  });

  // 手动刷新与变更刷新交错时，早发晚到的快照不能覆盖变更后的列表。
  test("变更后的重取不会被迟到旧 refresh 覆盖", async () => {
    let settle: (response: Response) => void = () => {};
    let gets = 0;
    respond = ({ init }) => {
      if (init.method !== "GET") return jsonResponse({ success: true, data: {} });
      gets += 1;
      if (gets === 2)
        return new Promise((resolve) => {
          settle = resolve;
        });
      return jsonResponse({ success: true, data: { spaces: [spacePayload(gets === 1 ? "old" : "new", "ins_1")] } });
    };
    const harness = createHarness();
    harness.render("ins_1");
    await flush();
    act(() => harness.snapshot().refreshSpaces());
    await act(async () => harness.snapshot().createSpace("new"));
    await flush();
    await act(async () => settle(jsonResponse({ success: true, data: { spaces: [spacePayload("stale", "ins_1")] } })));
    await flush();
    expect(harness.snapshot().spaces.map((space) => space.id)).toEqual(["new"]);
    harness.unmount();
  });

  // 没有实例就没有可查范围：null 与 undefined 都不发请求，落空列表 + 未加载
  test("instanceUid 为空时不发请求且落空态", async () => {
    const harness = createHarness();

    harness.render(null);
    await flush();
    expect(fetchCalls).toHaveLength(0);
    expect(harness.snapshot().spaces).toEqual([]);
    expect(harness.snapshot().spacesLoaded).toBe(false);

    harness.render(undefined);
    await flush();
    expect(fetchCalls).toHaveLength(0);
    expect(harness.snapshot().spacesLoaded).toBe(false);

    harness.unmount();
  });

  // 实例就绪后按 instanceUid 取列表，键名归一后的分组摘要直接透出，并标记该实例的列表已取到
  test("instanceUid 就绪时取列表并标记已加载", async () => {
    respond = () => jsonResponse({ success: true, data: { spaces: [spacePayload("space_1", "ins_1", ["ses_a"])] } });
    const harness = createHarness();

    harness.render("ins_1");
    await flush();

    expect(fetchCalls[0]?.[0]).toBe("/web/chat-spaces?instanceUid=ins_1");
    expect(fetchCalls[0]?.[1].method).toBe("GET");
    expect(harness.snapshot().spacesLoaded).toBe(true);
    expect(harness.snapshot().spaces.map((space) => [space.id, space.name, space.sessionIds])).toEqual([
      ["space_1", "space_1", ["ses_a"]],
    ]);

    harness.unmount();
  });

  // 切换实例立即重取；新实例的响应到达前不得把上一个实例的分组当成它的（否则会把 A 的分组画到 B 上）
  test("切换实例重取列表且不短暂透出旧实例分组", async () => {
    respond = ({ url }) =>
      jsonResponse({
        success: true,
        data: {
          spaces: url.includes("ins_2") ? [spacePayload("space_2", "ins_2")] : [spacePayload("space_1", "ins_1")],
        },
      });
    const harness = createHarness();

    harness.render("ins_1");
    await flush();
    expect(harness.snapshot().spaces.map((space) => space.id)).toEqual(["space_1"]);

    harness.render("ins_2");
    // 重取的响应尚未落地：此时必须是空态，而不是 ins_1 的分组
    expect(harness.snapshot().spaces).toEqual([]);
    expect(harness.snapshot().spacesLoaded).toBe(false);
    await flush();

    expect(fetchCalls[1]?.[0]).toBe("/web/chat-spaces?instanceUid=ins_2");
    expect(harness.snapshot().spaces.map((space) => space.id)).toEqual(["space_2"]);
    expect(harness.snapshot().spacesLoaded).toBe(true);

    harness.unmount();
  });

  // 变更失败必须抛给调用方（含后端错误码），且不触发重取：否则 UI 会把失败当成功
  test("变更失败向调用方抛出 ApiError 且不重取列表", async () => {
    let phase: "list" | "mutation" = "list";
    respond = () =>
      phase === "list"
        ? jsonResponse({ success: true, data: { spaces: [spacePayload("space_1", "ins_1")] } })
        : jsonResponse({ success: false, error: { code: "conflict", message: "分组名已存在" } });
    const harness = createHarness();

    harness.render("ins_1");
    await flush();
    phase = "mutation";

    let failure: unknown = null;
    await act(async () => {
      try {
        await harness.snapshot().createSpace("调研");
      } catch (error) {
        failure = error;
      }
    });

    if (!(failure instanceof ApiError)) throw new Error(`期望抛出 ApiError，实际为 ${String(failure)}`);
    expect(failure.code).toBe("conflict");
    expect(failure.message).toBe("分组名已存在");
    expect(fetchCalls.map(([, init]) => init.method)).toEqual(["GET", "POST"]);
    expect(harness.snapshot().spaces.map((space) => space.id)).toEqual(["space_1"]);

    harness.unmount();
  });

  // 变更成功后重取列表（服务端权威）：新建的分组经第二次 GET 出现在本地列表里
  test("变更成功后重取列表并展示新分组", async () => {
    let listCount = 0;
    respond = ({ init }) => {
      if (init.method === "POST") {
        return jsonResponse({
          success: true,
          data: { space: spacePayload("space_2", "ins_1") },
        });
      }
      listCount += 1;
      const spaces =
        listCount === 1
          ? [spacePayload("space_1", "ins_1")]
          : [spacePayload("space_1", "ins_1"), spacePayload("space_2", "ins_1")];
      return jsonResponse({ success: true, data: { spaces } });
    };
    const harness = createHarness();

    harness.render("ins_1");
    await flush();
    expect(harness.snapshot().spaces).toHaveLength(1);

    await act(async () => {
      await harness.snapshot().createSpace("调研");
    });
    await flush();

    expect(fetchCalls.map(([, init]) => init.method)).toEqual(["GET", "POST", "GET"]);
    expect(harness.snapshot().spaces.map((space) => space.id)).toEqual(["space_1", "space_2"]);

    harness.unmount();
  });

  // 移出只看 sessionId，不做本地反查：本地快照可能滞后于在途写入（刚移入的分组还没回来），
  // 按它反查出的分组 id 会让服务端的摘除落在空行上，用户的移出被静默丢弃。摘除范围由服务端按 scope 决定。
  test("移出会话无条件发 DELETE，不按本地快照反查分组", async () => {
    respond = ({ init }) =>
      init.method === "DELETE"
        ? jsonResponse({ success: true, data: { space: null } })
        : jsonResponse({ success: true, data: { spaces: [spacePayload("space_1", "ins_1")] } });
    const harness = createHarness();

    harness.render("ins_1");
    await flush();

    // 本地列表里没有任何分组含 ses_b：旧实现此时不发请求，现在必须发——真实归属只有服务端知道。
    await act(async () => {
      await harness.snapshot().unassignSession("ses_b");
    });

    expect(fetchCalls.map(([url, init]) => [url, init.method])).toEqual([
      ["/web/chat-spaces?instanceUid=ins_1", "GET"],
      ["/web/chat-spaces/sessions/ses_b?instanceUid=ins_1", "DELETE"],
      ["/web/chat-spaces?instanceUid=ins_1", "GET"],
    ]);

    harness.unmount();
  });

  // 列表加载失败必须与原状态区分开：spacesLoaded 保持 false、spaces 落空数组，spacesError 置位。
  // 失败若映射成空列表 + 已加载，消费方会把「请求失败」画成「没有分组」（前端规范 §3.4）。
  test("列表加载失败时 spacesError 透出且不标记已加载", async () => {
    respond = () => jsonResponse({ success: false, error: { code: "internal", message: "boom" } });
    const harness = createHarness();

    harness.render("ins_1");
    await flush();

    expect(harness.snapshot().spacesError).toBe(true);
    expect(harness.snapshot().spacesLoaded).toBe(false);
    expect(harness.snapshot().spaces).toEqual([]);

    harness.unmount();
  });

  // 失败态是当前状态而非历史痕迹：重取成功后必须清空（否则重试按钮会一直挂在已恢复的列表上）。
  test("重取成功后清空失败态", async () => {
    let failing = true;
    respond = () =>
      failing
        ? jsonResponse({ success: false, error: { code: "internal", message: "boom" } })
        : jsonResponse({ success: true, data: { spaces: [spacePayload("space_1", "ins_1")] } });
    const harness = createHarness();

    harness.render("ins_1");
    await flush();
    expect(harness.snapshot().spacesError).toBe(true);

    failing = false;
    await act(async () => {
      harness.snapshot().refreshSpaces();
    });
    await flush();

    expect(harness.snapshot().spacesError).toBe(false);
    expect(harness.snapshot().spaces.map((space) => space.id)).toEqual(["space_1"]);

    harness.unmount();
  });

  // 失败态按实例归属：A 的失败不跟着切到 B——否则 B 的「装载中」会被画成失败。
  test("实例切换后不继承上一个实例的失败态", async () => {
    respond = ({ url }) =>
      url.includes("ins_2")
        ? jsonResponse({ success: true, data: { spaces: [] } })
        : jsonResponse({ success: false, error: { code: "internal", message: "boom" } });
    const harness = createHarness();

    harness.render("ins_1");
    await flush();
    expect(harness.snapshot().spacesError).toBe(true);

    harness.render("ins_2");
    await flush();
    expect(harness.snapshot().spacesError).toBe(false);

    harness.unmount();
  });

  // 实例未就绪时所有变更动作必须直接抛错且不发请求：instanceUid 是服务端的权威作用域，
  // 缺了它只能发出作用域不明的请求（与 createSpace 同口径）
  test("instanceUid 缺失时变更动作抛错且不发请求", async () => {
    const harness = createHarness();

    harness.render(null);
    await flush();

    for (const action of [
      () => harness.snapshot().renameSpace("space_1", "新名"),
      () => harness.snapshot().assignSession("space_1", "ses_a"),
      () => harness.snapshot().unassignSession("ses_a"),
    ]) {
      let failure: unknown = null;
      await act(async () => {
        try {
          await action();
        } catch (error) {
          failure = error;
        }
      });
      expect(failure).toBeInstanceOf(Error);
      // 开发者诊断文案（英文）：它会经提示槽位透出，写中文会在英文界面下露出半截中文
      expect((failure as Error).message).toContain("requires an instanceUid");
    }
    // 列表本来就没发（无实例），三个动作也不得发出任何请求
    expect(fetchCalls).toHaveLength(0);

    harness.unmount();
  });
});
