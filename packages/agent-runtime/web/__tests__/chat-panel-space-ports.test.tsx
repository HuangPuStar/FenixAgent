// ChatPanel 端口装配的 space 数据流测试。
//
// 覆盖上一阶段冻结的接线约定：`instanceUid` 取持久实例 uid（本 hook 的 `sessionId`）、实例未选中时整组端口
// 都不注入且不发请求、列表未到达前不把空数组当「已接入且无分组」、切换实例重取，以及写动作失败原样抛给
// ui-components 的失败提示出口（端口吞掉 rejection 就等于静默失败）。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { ApiError } from "@fenix/web-runtime/api/request";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type ChatPanelPorts, useChatPanelPorts } from "../agent-panel/chat-panel-ports";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 设置最小 DOM 环境（react-dom/client 与 ahooks 加载时需要 window；仅在本文件作用域内生效）
const win = initializeHappyDomWindow(new Window());
const globalRecord = globalThis as Record<string, unknown>;
globalRecord.window = win;
globalRecord.document = win.document;
globalRecord.navigator = win.navigator;

const AGENT_ID = "env_1";
/** 持久实例 uid：URL 段 `/agent/chat/{agentId}/{instanceUid}` 与 `ACPMain.detailSessionId` 的同一个值 */
const INSTANCE_UID = "ins_1";

const fetchCalls: Array<[string, RequestInit]> = [];

// `globalThis.fetch` 是进程级全局：装桩后必须还原，避免其后运行的服务端用例收到这里的桩响应
let originalFetch: typeof globalThis.fetch;

/** 当前用例的响应工厂，默认给空分组列表；需要失败或特异载荷的用例自行替换 */
let respond: (call: { url: string; init: RequestInit }) => Response = () =>
  jsonResponse({ success: true, data: { spaces: [] } });

/** 构造 JSON 响应（request 层按 Content-Type 判定解析路径） */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

/** 后端视图形状的分组载荷（snake_case 由 client 归一） */
function spacePayload(id: string, instanceUid: string, sessionIds: string[] = []) {
  return { id, instance_uid: instanceUid, name: id, session_ids: sessionIds };
}

/** 只挑出分组接口的调用：本 hook 还会经其它端口模块拉起无关请求（若有）时断言不被干扰 */
function chatSpaceCalls(): Array<[string, RequestInit]> {
  return fetchCalls.filter(([url]) => url.includes("/web/chat-spaces"));
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

/** 渲染真实端口 hook 的探针组件，返回最新端口快照与重渲染 / 卸载控制 */
function createHarness() {
  const latest = { value: null as ChatPanelPorts | null };
  function Probe({ sessionId }: { sessionId: string | null }) {
    latest.value = useChatPanelPorts({ agentId: AGENT_ID, sessionId });
    return null;
  }
  const container = win.document.createElement("div");
  const root: Root = createRoot(container as unknown as HTMLElement);
  return {
    /** 当前渲染的端口集合（未渲染时直接失败，避免用例里到处写非空断言） */
    ports: (): ChatPanelPorts => {
      if (!latest.value) throw new Error("端口 hook 尚未渲染出快照");
      return latest.value;
    },
    render: (sessionId: string | null) =>
      act(() => {
        root.render(createElement(Probe, { sessionId }));
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

describe("useChatPanelPorts 的 space 端口", () => {
  // 未选中实例：不发分组请求，整组端口全部缺省（侧栏据此退化为「今天/昨天/更早」时间分组）
  test("未选中实例时不发请求且整组端口缺省", async () => {
    const harness = createHarness();

    harness.render(null);
    await flush();

    expect(chatSpaceCalls()).toHaveLength(0);
    const ports = harness.ports();
    expect(ports.spaces).toBeUndefined();
    expect(ports.spacesLoaded).toBeUndefined();
    expect(ports.spacesError).toBeUndefined();
    expect(ports.onRefreshSpaces).toBeUndefined();
    expect(ports.onCreateSpace).toBeUndefined();
    expect(ports.onRenameSpace).toBeUndefined();
    expect(ports.onAssignSession).toBeUndefined();
    expect(ports.onUnassignSession).toBeUndefined();

    harness.unmount();
  });

  // 实例就绪后按持久实例 uid 取分组：列表到达即透出摘要，写入口同时接上
  test("实例就绪后按 instanceUid 取分组并透出", async () => {
    respond = () =>
      jsonResponse({ success: true, data: { spaces: [spacePayload("space_1", INSTANCE_UID, ["ses_a"])] } });
    const harness = createHarness();

    harness.render(INSTANCE_UID);
    await flush();

    expect(fetchCalls[0]?.[0]).toBe(`/web/chat-spaces?instanceUid=${INSTANCE_UID}`);
    const ports = harness.ports();
    expect(ports.spacesLoaded).toBe(true);
    expect(ports.spaces?.map((space) => [space.id, space.sessionIds])).toEqual([["space_1", ["ses_a"]]]);
    expect(typeof ports.onCreateSpace).toBe("function");
    expect(typeof ports.onAssignSession).toBe("function");

    harness.unmount();
  });

  // 列表未到达前 spaces 传 undefined：空数组会被侧栏读成「已接入且无分组」，先画出只含「默认」的假分组
  test("列表未到达前 spaces 为 undefined 而 spacesLoaded 为 false", () => {
    const harness = createHarness();

    harness.render(INSTANCE_UID);

    // 同步断言：此刻请求已发出但响应尚未落地（act 的同步路径不等待微任务）
    expect(harness.ports().spaces).toBeUndefined();
    expect(harness.ports().spacesLoaded).toBe(false);

    harness.unmount();
  });

  // 切换实例立即重取；新实例的响应到达前不得把上一个实例的分组透出去（否则会把实例 A 的分组画到 B 上）
  test("切换实例重取且不短暂透出旧实例分组", async () => {
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
    expect(harness.ports().spaces?.map((space) => space.id)).toEqual(["space_1"]);

    harness.render("ins_2");
    expect(harness.ports().spaces).toBeUndefined();
    expect(harness.ports().spacesLoaded).toBe(false);
    await flush();

    expect(chatSpaceCalls().map(([url]) => url)).toEqual([
      "/web/chat-spaces?instanceUid=ins_1",
      "/web/chat-spaces?instanceUid=ins_2",
    ]);
    expect(harness.ports().spaces?.map((space) => space.id)).toEqual(["space_2"]);

    harness.unmount();
  });

  // 会话删除后的归属清理走同一组端口：按会话 + 实例发 DELETE（摘除范围由服务端按 scope 决定，
  // 调用方不做本地反查；后端对「本就不在分组」幂等）
  test("移出会话时发 DELETE 且带 instanceUid", async () => {
    respond = ({ init }) =>
      init.method === "DELETE"
        ? jsonResponse({ success: true, data: { space: spacePayload("space_1", INSTANCE_UID) } })
        : jsonResponse({ success: true, data: { spaces: [spacePayload("space_1", INSTANCE_UID, ["ses_a"])] } });
    const harness = createHarness();

    harness.render(INSTANCE_UID);
    await flush();

    await act(async () => {
      await harness.ports().onUnassignSession?.("ses_a");
    });

    const deleteCalls = fetchCalls.filter(([, init]) => init.method === "DELETE");
    expect(deleteCalls.map(([url]) => url)).toEqual([`/web/chat-spaces/sessions/ses_a?instanceUid=${INSTANCE_UID}`]);

    harness.unmount();
  });

  // 连续两次归属写（移入后立刻移出）不读本地快照定位：第二次的 DELETE 不带分组 id，摘除范围由服务端
  // 按 scope 决定。按滞后快照反查会定位到旧分组（本例里 ses_a 还在 space_1），摘除落在空行上，用户的
  // 移出被静默丢弃——服务端最终仍认为它在 space_2。
  test("连续两次归属写不依赖滞后的本地快照", async () => {
    respond = ({ init }) =>
      init.method === "GET"
        ? jsonResponse({ success: true, data: { spaces: [spacePayload("space_1", INSTANCE_UID, ["ses_a"])] } })
        : jsonResponse({ success: true, data: { space: spacePayload("space_1", INSTANCE_UID) } });
    const harness = createHarness();

    harness.render(INSTANCE_UID);
    await flush();

    // 先移入 space_2（列表尚未重取，本地快照仍认为 ses_a 在 space_1）
    await act(async () => {
      await harness.ports().onAssignSession?.("space_2", "ses_a");
    });
    // 紧接着移出：本地快照滞后不影响摘除范围
    await act(async () => {
      await harness.ports().onUnassignSession?.("ses_a");
    });

    const mutations = chatSpaceCalls().filter(([, init]) => init.method !== "GET");
    expect(mutations.map(([url, init]) => [url, init.method])).toEqual([
      [`/web/chat-spaces/space_2/sessions/ses_a?instanceUid=${INSTANCE_UID}`, "PUT"],
      [`/web/chat-spaces/sessions/ses_a?instanceUid=${INSTANCE_UID}`, "DELETE"],
    ]);

    harness.unmount();
  });

  // 列表加载失败必须经 `spacesError` 透出（侧栏据此给可重试提示）：失败落成空列表 + loaded=false 会让
  // 用户把它当成「没有分组」或永久加载中，`onRefreshSpaces` 是唯一的恢复入口
  test("列表加载失败时 spacesError 透出且可重试", async () => {
    let failing = true;
    respond = () =>
      failing
        ? jsonResponse({ success: false, error: { code: "internal", message: "boom" } })
        : jsonResponse({ success: true, data: { spaces: [spacePayload("space_1", INSTANCE_UID)] } });
    const harness = createHarness();

    harness.render(INSTANCE_UID);
    await flush();

    const failed = harness.ports();
    expect(failed.spacesError).toBe(true);
    expect(failed.spacesLoaded).toBe(false);
    expect(typeof failed.onRefreshSpaces).toBe("function");

    failing = false;
    await act(async () => {
      failed.onRefreshSpaces?.();
    });
    await flush();

    const recovered = harness.ports();
    expect(recovered.spacesError).toBe(false);
    expect(recovered.spaces?.map((space) => space.id)).toEqual(["space_1"]);

    harness.unmount();
  });

  // 写动作失败必须原样抛给调用方：ui-components 的失败提示出口靠这个 rejection 转 onNotice，吞掉即静默失败
  test("写动作失败原样抛出 ApiError", async () => {
    let phase: "list" | "mutation" = "list";
    respond = () =>
      phase === "list"
        ? jsonResponse({ success: true, data: { spaces: [] } })
        : jsonResponse({ success: false, error: { code: "conflict", message: "分组名已存在" } });
    const harness = createHarness();

    harness.render(INSTANCE_UID);
    await flush();
    phase = "mutation";

    let failure: unknown = null;
    await act(async () => {
      try {
        await harness.ports().onCreateSpace?.("调研");
      } catch (error) {
        failure = error;
      }
    });

    if (!(failure instanceof ApiError)) throw new Error(`期望抛出 ApiError，实际为 ${String(failure)}`);
    expect(failure.code).toBe("conflict");
    expect(failure.message).toBe("分组名已存在");

    harness.unmount();
  });
});
