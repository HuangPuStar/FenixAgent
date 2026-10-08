// web/__tests__/canvas-host-fallbacks.test.tsx
// 画布宿主页的降级分支（设计 §5.4 与 §6.2 的必备状态：初始化超时 / 上游不可用 / 上游未就绪 / empty）。
//
// 为什么每条分支都要渲染断言而不是只看状态函数：这些分支的价值恰恰在「什么时候**不**挂 iframe」——
// 上游未就绪时若仍拼一个 `space_id=` 空值的 URL，画布会加载并在读到一个空空间后到处报错，而页面上
// 看不出哪里不对。因此断言分成两层：不挂 iframe（未就绪）+ 卡上有正确的引导与动作（超时 / 失败 / empty）。
//
// 环境：happy-dom + react-dom/client（装置见 ./canvas-host-harness）；超时用例用假时钟推进。

import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { CANVAS_READY_TIMEOUT_MS } from "../pages/canvas/use-canvas-handshake";
import {
  type CanvasMount,
  CONSOLE_ORIGIN,
  captureHostMessages,
  type FetchCall,
  type FetchRoute,
  type FetchRouter,
  flushMicrotasks,
  installFetchRouter,
  mountCanvas,
  sendFromCanvas,
  sendFromCanvasAsync,
  sendRawMessage,
  upstreamOk,
  webErr,
  webOk,
  win,
} from "./canvas-host-harness";

mock.module("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
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

const i18n = createInstance();
void i18n.init({ lng: "zh", fallbackLng: "zh", initAsync: false, resources: {} });

let bindingRoute: FetchRoute;
let accountRoute: FetchRoute;

function route(call: FetchCall): FetchRoute {
  if (call.url === "/web/workflow-v2/org-app") return bindingRoute;
  if (call.url === "/web/workflow-v2/platform-account") return accountRoute;
  if (call.url === "/web/workflow-v2/iframe-code") return webOk({ code: "code-1", expiresIn: 60 });
  if (call.url.endsWith("/session/exchange")) return upstreamOk({ ticket: "ticket-1", expiresAt: 1_760_000_000_000 });
  if (call.url.endsWith("/session/revoke")) return upstreamOk({ revoked: true });
  return webErr("NOT_FOUND", "unexpected route", 404);
}

const BOUND_ACTIVE = webOk({ appId: "app-1", status: "active" });
const SPACE_READY = webOk({ spaceId: "space-1", status: "active" });

let router: FetchRouter;
let mount: CanvasMount;

beforeEach(() => {
  bindingRoute = BOUND_ACTIVE;
  accountRoute = SPACE_READY;
  router = installFetchRouter(route);
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

function frameOrNull(container: HTMLElement): HTMLIFrameElement | null {
  return container.querySelector("iframe") as HTMLIFrameElement | null;
}

/** 在整棵文档里按可见文案找按钮（覆盖层与卡片都在用例容器内）。 */
function buttonByText(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  for (const button of container.querySelectorAll("button")) {
    if ((button.textContent ?? "").trim() === label) return button as unknown as HTMLButtonElement;
  }
  return;
}

describe("上游未就绪的降级", () => {
  // 未绑定租户 App：empty 引导（而不是拼一个没有 App 归属的画布 URL）+ 重试入口；绑定完成后重试即可进入。
  test("未绑定租户 App 时不挂 iframe，并给出绑定引导", async () => {
    bindingRoute = webOk({ appId: null, status: "unbound" });
    await mount.render(page());

    expect(frameOrNull(mount.container)).toBeNull();
    expect(mount.container.textContent).toContain("canvas.state.blocked.unbound.title");
    expect(mount.container.textContent).toContain("canvas.state.blocked.unbound.description");
    expect(mount.container.textContent).toContain("canvas.action.backToList");

    // 绑定补齐后重试：重新探测并进入画布（重试不能只是刷新界面，必须真的重查上游状态）
    bindingRoute = BOUND_ACTIVE;
    await act(async () => {
      buttonByText(mount.container, "canvas.action.retry")?.click();
    });
    await mount.flush();

    expect(router.callsTo("/web/workflow-v2/org-app").length).toBe(2);
    expect(frameOrNull(mount.container)).not.toBeNull();
  });

  // 平台空间 ID 拿不到时**不拼 URL**：`space_id=` 空值会让画布读到空串并当成有效空间。
  test("平台空间缺失时不拼 URL，提示上游未就绪", async () => {
    accountRoute = webOk({ spaceId: null, status: "active" });
    await mount.render(page());

    expect(frameOrNull(mount.container)).toBeNull();
    expect(mount.container.textContent).toContain("canvas.state.blocked.spaceMissing.title");
  });

  // 平台空间缺失是**可自愈的过渡态**（服务端读路径此时会按需引导平台账号）：页面自己重试几次就能进入画布，
  // 不该让用户为一次性初始化手点「重试」。这里用真实时钟等过一档自动重试间隔，断言「无需点击即恢复」。
  test("空间缺失时自动重试探测，恢复后直接进入画布", async () => {
    accountRoute = webOk({ spaceId: null, status: "active" });
    await mount.render(page());

    expect(frameOrNull(mount.container)).toBeNull();
    expect(mount.container.textContent).toContain("canvas.state.blocked.spaceMissing.title");

    // 服务端按需引导完成后空间就有了；期间**没有任何点击**。
    accountRoute = SPACE_READY;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    });
    await mount.flush();

    expect(frameOrNull(mount.container)).not.toBeNull();
    expect(mount.container.textContent).not.toContain("canvas.state.blocked.spaceMissing.title");
  });

  // 绑定被上游标记不可用：与「未绑定」是不同的引导（前者要管理员处理上游，后者要管理员去绑定）。
  test("绑定 degraded 时给出上游不可用提示", async () => {
    bindingRoute = webOk({ appId: "app-1", status: "degraded" });
    await mount.render(page());

    expect(frameOrNull(mount.container)).toBeNull();
    expect(mount.container.textContent).toContain("canvas.state.blocked.degraded.title");
  });

  // 探测请求失败（500）：状态未知 ⇒ 不能当成「没绑定」，文案必须是「无法确认上游状态」且可重试。
  test("探测失败提示无法确认上游状态，重试后恢复", async () => {
    bindingRoute = webErr("INTERNAL_ERROR", "boom", 500);
    await mount.render(page());

    expect(frameOrNull(mount.container)).toBeNull();
    expect(mount.container.textContent).toContain("canvas.state.blocked.probeFailed.title");

    bindingRoute = BOUND_ACTIVE;
    await act(async () => {
      buttonByText(mount.container, "canvas.action.retry")?.click();
    });
    await mount.flush();
    expect(frameOrNull(mount.container)).not.toBeNull();
  });

  // 宽度契约（happy-dom 量不到布局，这里只钉住那条唯一的横向滚动层与 iframe 的宽度下限）：
  // 上游画布的根容器是固定 1200px 的三栏布局；若 iframe 交给容器宽度（去掉 `min-w-300`），窄视口下
  // 画布会**文档级**溢出，出现「iframe 内部 + 容器」两级横向滚动且右侧面板被 iframe 边缘裁掉。
  test("iframe 带宽度下限，横向滚动只有容器一层", async () => {
    await mount.render(page());

    const iframe = frameOrNull(mount.container);
    if (iframe === null) throw new Error("iframe 未渲染");
    expect(iframe.className).toContain("min-w-300");
    const frameHost = iframe.parentElement;
    expect(frameHost?.className).toContain("overflow-x-auto");
    // 两层嵌套滚动是这次的缺陷形态：容器之外的祖先不得再开横向滚动。
    expect(frameHost?.parentElement?.className ?? "").not.toContain("overflow-x-auto");
  });
});

describe("画布侧的失败分支", () => {
  // iframe 自身加载失败（连接级错误时画布不会发 ready）：由 DOM 的 error 事件直接降级，不等 10s 超时。
  test("iframe 加载失败展示加载失败卡", async () => {
    await mount.render(page());
    const iframe = frameOrNull(mount.container);
    if (iframe === null) throw new Error("iframe 未渲染");

    await act(async () => {
      iframe.dispatchEvent(new win.Event("error") as unknown as Event);
    });
    await mount.flush();

    expect(mount.container.textContent).toContain("canvas.state.loadFailed.title");
  });

  // 画布上报致命错误且 retryable=true：给重试；画布给的 message 不上屏（只按自己的字典文案）。
  test("画布 error 可重试时给重试入口", async () => {
    await mount.render(page());
    const iframe = frameOrNull(mount.container);
    if (iframe === null) throw new Error("iframe 未渲染");

    await sendFromCanvasAsync(mount.flush, iframe, "error", {
      code: "500",
      message: "internal stack trace",
      retryable: true,
    });

    expect(mount.container.textContent).toContain("canvas.state.canvasError.title");
    expect(mount.container.textContent).not.toContain("internal stack trace");
    expect(buttonByText(mount.container, "canvas.action.retry")).toBeDefined();
  });

  // retryable=false（画布判定不可自愈）：不给重试，只留返回列表——重试一个可预知会失败的请求没有意义。
  test("画布 error 不可重试时只留返回列表", async () => {
    await mount.render(page());
    const iframe = frameOrNull(mount.container);
    if (iframe === null) throw new Error("iframe 未渲染");

    await sendFromCanvasAsync(mount.flush, iframe, "error", { code: "402", message: "quota", retryable: false });

    expect(mount.container.textContent).toContain("canvas.state.canvasError.title");
    expect(buttonByText(mount.container, "canvas.action.retry")).toBeUndefined();
    expect(mount.container.textContent).toContain("canvas.action.backToList");
  });

  // 安全边界：非本 iframe 的 source、跨域 origin、版本不符的消息一律不触发握手（否则同源的其它窗口
  // 或 opener 可以骗宿主签发 code 并把票据拐走）。
  test("异源 / 非本 iframe / 版本不符的消息被忽略", async () => {
    await mount.render(page());
    const iframe = frameOrNull(mount.container);
    if (iframe === null) throw new Error("iframe 未渲染");
    const envelope = { v: 1, id: "forged", type: "ready", ts: Date.now(), payload: {} };

    // ① origin 不符
    sendRawMessage({ data: envelope, origin: "https://evil.example.com", source: iframe.contentWindow });
    // ② source 不是本 iframe（同源的其它窗口）
    sendRawMessage({ data: envelope, origin: CONSOLE_ORIGIN, source: win });
    // ③ 信封版本不符
    sendRawMessage({ data: { ...envelope, v: 2 }, origin: CONSOLE_ORIGIN, source: iframe.contentWindow });
    await mount.flush();

    expect(router.callsTo("iframe-code").length).toBe(0);
    expect(router.callsTo("/session/exchange").length).toBe(0);
  });
});

describe("初始化超时", () => {
  // 文档已 load 但画布没在 10s 内发 ready：初始化超时卡（与「加载失败」区分），可重试；
  // 重试 = 重挂载 iframe + 重新握手（而不是只重绘一次卡片）。
  test("ready 超时后展示超时卡，重试后重新握手", async () => {
    jest.useFakeTimers();
    try {
      await act(async () => {
        mount.root.render(page());
      });
      await flushMicrotasks();
      const first = frameOrNull(mount.container);
      if (first === null) throw new Error("iframe 未渲染");
      expect(mount.container.textContent).toContain("canvas.announce.connecting");

      await act(async () => {
        jest.advanceTimersByTime(CANVAS_READY_TIMEOUT_MS);
      });
      await flushMicrotasks();
      expect(mount.container.textContent).toContain("canvas.state.timeout.title");
      expect(router.callsTo("iframe-code").length).toBe(0);

      await act(async () => {
        buttonByText(mount.container, "canvas.action.retry")?.click();
      });
      await flushMicrotasks();

      const retried = frameOrNull(mount.container);
      if (retried === null) throw new Error("重试后 iframe 未渲染");
      const sent = captureHostMessages(retried);
      await act(async () => {
        sendFromCanvas(retried, "ready", {});
      });
      await flushMicrotasks();
      for (let i = 0; i < 4; i += 1) await flushMicrotasks();

      // 重新握手仍然走完整链路，并重新把票据交给画布
      expect(router.callsTo("iframe-code").length).toBe(1);
      expect(sent.map((message) => message.type)).toEqual(["token"]);
      expect(mount.container.textContent).toContain("canvas.announce.ready");
    } finally {
      jest.useRealTimers();
    }
  });

  // 与上一条互补：加载失败事件与超时是两条不同的信号，超时不得被报成「加载失败」，
  // 否则用户会去查网络连通性，而真正的问题是画布没起来（上游慢 / 前端异常）。
  test("超时归为初始化超时，而不是加载失败", async () => {
    jest.useFakeTimers();
    try {
      await act(async () => {
        mount.root.render(page());
      });
      await flushMicrotasks();

      await act(async () => {
        jest.advanceTimersByTime(CANVAS_READY_TIMEOUT_MS);
      });
      await flushMicrotasks();

      expect(mount.container.textContent).toContain("canvas.state.timeout.title");
      expect(mount.container.textContent).not.toContain("canvas.state.loadFailed.title");
    } finally {
      jest.useRealTimers();
    }
  });
});
