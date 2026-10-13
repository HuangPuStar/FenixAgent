// web/__tests__/canvas-handshake-sequence.test.tsx
// 画布宿主页的握手时序（冻结 §7「宿主页采用的握手路径」）。
//
// 为什么必须把请求链与 postMessage 一起断言：这条链路的每一步都在换一个进程边界——控制台会话签一次性
// code、宿主自己兑换票据、再经 postMessage 把票据交给画布。任何一步顺序错了（比如把 code 下发给画布、
// 或先发 token 再换票）在单侧看都「成功」，只有把「打了哪些请求、按什么顺序、发了什么消息」放在一起
// 才能钉住。因此本文件断言 fetch 调用序列 + 宿主发出的信封内容与 targetOrigin。
//
// 环境：happy-dom + react-dom/client（装置见 ./canvas-host-harness）。跨包只 mock 路由：用例不需要整棵
// 路由树，`Link` / `useNavigate` 用并集替身（并集口径与同批其它包一致，避免进程级 mock 影响后续文件）。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createInstance } from "i18next";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { CANVAS_API_BASE, CANVAS_TICKET_HEADER } from "../api/canvas-session";
import {
  type CanvasMount,
  captureHostMessages,
  type FetchCall,
  type FetchRoute,
  type FetchRouter,
  installFetchRouter,
  mountCanvas,
  type SentMessage,
  sendFromCanvasAsync,
  upstreamErr,
  upstreamOk,
  webErr,
  webOk,
} from "./canvas-host-harness";

/** 宿主路由的跳转记录：`navigate-out` 必须走宿主路由，而不是 iframe 自己整页跳转。 */
let navigations: Array<Record<string, unknown>> = [];

mock.module("@tanstack/react-router", () => ({
  useNavigate: () => (options: Record<string, unknown>) => {
    navigations.push(options);
  },
  useSearch: () => ({}),
  useLocation: () => ({ pathname: "/", search: "", hash: "", state: null, key: "default" }),
  useParams: () => ({}),
  Link: ({ to, children, className }: { to?: string; children?: unknown; className?: string }) =>
    createElement("a", { href: to, className }, children as never),
}));

afterEach(() => {
  mock.restore();
});

const { WorkflowCanvasHostPage } = await import("../pages/canvas/canvas-host-page");

// 空字典的 i18n 实例：`t()` 原样回显 key，断言因此不随文案改动失真。
const i18n = createInstance();
void i18n.init({ lng: "zh", fallbackLng: "zh", initAsync: false, resources: {} });

const TICKET_EXPIRES_AT = 1_760_000_000_000;
const REFRESHED_EXPIRES_AT = TICKET_EXPIRES_AT + 900_000;

/** 每个用例可覆盖的两条路由：兑换与续期（其余端点行为固定）。 */
let exchangeRoute: FetchRoute;
let refreshRoute: FetchRoute;

function defaultRoute(call: FetchCall): FetchRoute {
  if (call.url === "/web/workflow-v2/org-app") return webOk({ appId: "app-1", status: "active" });
  if (call.url === "/web/workflow-v2/platform-account") return webOk({ spaceId: "space-1", status: "active" });
  if (call.url === "/web/workflow-v2/iframe-code") return webOk({ code: "code-1", expiresIn: 60 });
  if (call.url.endsWith("/session/exchange")) return exchangeRoute;
  if (call.url.endsWith("/session/refresh")) return refreshRoute;
  if (call.url.endsWith("/session/revoke")) return upstreamOk({ revoked: true });
  return webErr("NOT_FOUND", "unexpected route", 404);
}

let router: FetchRouter;
let mount: CanvasMount;

beforeEach(() => {
  navigations = [];
  exchangeRoute = upstreamOk({ ticket: "ticket-1", expiresAt: TICKET_EXPIRES_AT });
  refreshRoute = upstreamOk({ ticket: "ticket-2", expiresAt: REFRESHED_EXPIRES_AT });
  router = installFetchRouter(defaultRoute);
  mount = mountCanvas();
});

afterEach(() => {
  mount.unmount();
  router.restore();
});

function page(): ReturnType<typeof createElement> {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(WorkflowCanvasHostPage, { upstreamWorkflowId: "wf-1" }),
  );
}

function frame(container: HTMLElement): HTMLIFrameElement {
  const node = container.querySelector("iframe");
  if (node === null) throw new Error("iframe 未渲染");
  return node as HTMLIFrameElement;
}

/** 宿主 → 画布 消息的类型序列；断言顺序时直接比数组。 */
function sentTypes(sent: SentMessage[]): string[] {
  return sent.map((message) => message.type);
}

describe("画布宿主页的握手时序", () => {
  // 主链路：ready → 控制台签发一次性 code → 宿主自己兑换票据 → token 下发（冻结 §7 的 token 路径）。
  // 同时钉住「code 不下发给画布」：宿主发的第一条消息只能是 token。
  test("ready 后按序签发 code、兑换票据、下发 token", async () => {
    await mount.render(page());

    // 上游就绪后才挂 iframe；URL 参数用上游认识的名字
    const iframe = frame(mount.container);
    expect(iframe.getAttribute("src")).toContain("/workflow-canvas/work_flow?");
    expect(iframe.getAttribute("src")).toContain("workflow_id=wf-1");
    expect(iframe.getAttribute("src")).toContain("space_id=space-1");
    expect(iframe.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals",
    );
    expect(iframe.getAttribute("title")).toBe("canvas.frameTitle");
    // ready 之前盖骨架（画布不可交互）
    expect(mount.container.querySelector("[aria-busy='true']")).not.toBeNull();

    const sent = captureHostMessages(iframe);
    await sendFromCanvasAsync(mount.flush, iframe, "ready", { capabilities: ["ticket"] });

    // 顺序：先签发（控制台会话），再兑换（BFF 免票端点），最后才是 token
    const handshakeUrls = router.calls
      .filter((call) => call.url.includes("iframe-code") || call.url.includes("/session/exchange"))
      .map((call) => call.url);
    expect(handshakeUrls).toEqual(["/web/workflow-v2/iframe-code", `${CANVAS_API_BASE}/session/exchange`]);
    expect(router.calls.find((call) => call.url.includes("iframe-code"))?.body).toEqual({ workflowId: "wf-1" });
    expect(router.calls.find((call) => call.url.includes("/session/exchange"))?.body).toEqual({ code: "code-1" });

    // 下发的载荷与画布侧 host-bridge 的读法逐字对齐；targetOrigin 必须是控制台自身 origin，不得用 "*"
    expect(sentTypes(sent)).toEqual(["token"]);
    expect(sent[0].payload).toEqual({
      apiBase: CANVAS_API_BASE,
      ticket: "ticket-1",
      expiresAt: TICKET_EXPIRES_AT,
    });
    expect(sent[0].targetOrigin).toBe("https://console.example.com");

    // 票据到手后骨架撤除，画布可交互
    expect(mount.container.querySelector("[aria-busy='true']")).toBeNull();
  });

  // code 是单次消费的：画布重复 ready（重挂载、重复握手）不能重开一次签发，否则白费一个 code。
  test("重复 ready 不重复签发 code", async () => {
    await mount.render(page());
    const iframe = frame(mount.container);
    captureHostMessages(iframe);

    await sendFromCanvasAsync(mount.flush, iframe, "ready", {});
    await sendFromCanvasAsync(mount.flush, iframe, "ready", {});

    expect(router.callsTo("iframe-code").length).toBe(1);
    expect(router.callsTo("/session/exchange").length).toBe(1);
  });

  // 续期：refresh-request → 宿主用**自己持有的票据**调 session/refresh → 新 token 下发（冻结 §7）。
  test("refresh-request 带票据头续期并下发新 token", async () => {
    await mount.render(page());
    const iframe = frame(mount.container);
    const sent = captureHostMessages(iframe);
    await sendFromCanvasAsync(mount.flush, iframe, "ready", {});
    sent.length = 0;

    await sendFromCanvasAsync(mount.flush, iframe, "refresh-request", { reason: "unauthorized" });

    const refreshCalls = router.callsTo("/session/refresh");
    expect(refreshCalls.length).toBe(1);
    expect(refreshCalls[0].method).toBe("POST");
    // 请求头名固定 X-Fenix-Workflow-Ticket（画布侧只认这个名字）
    expect(refreshCalls[0].headers[CANVAS_TICKET_HEADER.toLowerCase()]).toBe("ticket-1");
    expect(sentTypes(sent)).toEqual(["token"]);
    expect(sent[0].payload).toEqual({
      apiBase: CANVAS_API_BASE,
      ticket: "ticket-2",
      expiresAt: REFRESHED_EXPIRES_AT,
    });
    // 续期不该重新签发 code
    expect(router.callsTo("iframe-code").length).toBe(1);
  });

  // 续期失败（票据被撤销或过期 → 真实 401）：下发 signout 并切到「会话已失效」覆盖层，
  // 且**不给重试**（重试还是会话已死的同一条链路），出口只有返回列表。
  test("续期失败下发 signout 并展示会话已失效覆盖层", async () => {
    await mount.render(page());
    const iframe = frame(mount.container);
    const sent = captureHostMessages(iframe);
    await sendFromCanvasAsync(mount.flush, iframe, "ready", {});
    sent.length = 0;

    refreshRoute = upstreamErr(401, "ticket_invalid");
    await sendFromCanvasAsync(mount.flush, iframe, "refresh-request", { reason: "unauthorized" });

    expect(sentTypes(sent)).toEqual(["signout"]);
    expect(sent[0].targetOrigin).toBe("https://console.example.com");
    expect(mount.container.textContent).toContain("canvas.state.sessionExpired.title");
    expect(mount.container.textContent).toContain("canvas.action.backToList");
    expect(mount.container.textContent).not.toContain("canvas.action.retry");
  });

  // 画布内的返回/跳转只发 navigate-out，由宿主路由处理（设计 §5.4：不允许 iframe 自行整页跳转）。
  test("navigate-out 交宿主路由返回列表", async () => {
    await mount.render(page());
    const iframe = frame(mount.container);
    await sendFromCanvasAsync(mount.flush, iframe, "ready", {});

    await sendFromCanvasAsync(mount.flush, iframe, "navigate-out", {});

    expect(navigations).toEqual([{ to: "/agent/workflow" }]);
  });

  // 离开页面（含切组织：宿主切换会导航并卸载本页）必须撤销票据族 + 让画布进中性页（冻结 §7）。
  test("卸载时下发 signout 并撤销票据族", async () => {
    await mount.render(page());
    const iframe = frame(mount.container);
    const sent = captureHostMessages(iframe);
    await sendFromCanvasAsync(mount.flush, iframe, "ready", {});
    sent.length = 0;

    mount.unmount();

    expect(sentTypes(sent)).toContain("signout");
    const revokeCalls = router.callsTo("/session/revoke");
    expect(revokeCalls.length).toBe(1);
    expect(revokeCalls[0].headers[CANVAS_TICKET_HEADER.toLowerCase()]).toBe("ticket-1");
  });
});
