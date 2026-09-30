// pages/canvas/use-canvas-handshake.ts
// 画布宿主页的**握手编排**：ready → 取一次性 code → 兑换票据 → `token` 下发；`refresh-request` → 续期；
// 离开页面 → 撤销（冻结 §7 的「宿主页采用的握手路径」）。
//
// 为什么走 `token` 而不是 `bind`（冻结 §7 已裁定，这里不再重开）：`bound` 的载荷只有 `{ ok, expiresAt }`，
// 票据若留在画布侧，宿主既无法在 `refresh-request` 时调 `session/refresh`（要 `X-Fenix-Workflow-Ticket`），
// 也无法在离开时调 `session/revoke`。走 `token` 后票据同时在宿主内存里，续期与撤销两条链路都在宿主侧闭环。
//
// 票据**只存内存**（`ticketRef`）：不入 URL、不入 storage、不进日志（设计 §5.3）。
//
// 时序上两个上限必须记住：画布侧等 `token` 只等 10s（`host-bridge.ts` 的 `TOKEN_WAIT_TIMEOUT_MS`），
// 因此续期链路上的每个请求都用 `CANVAS_SESSION_TIMEOUT_MS`（8s）而不是默认 30s——超时即降级，
// 由宿主先失败，而不是让画布先超时。

import { unwrap } from "@fenix/web-runtime/api/request";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import {
  CANVAS_API_BASE,
  type CanvasTicket,
  exchangeCanvasTicket,
  issueCanvasCode,
  refreshCanvasTicket,
  revokeCanvasTicket,
} from "../../api/canvas-session";
import type { CanvasFramePhase } from "./canvas-hosting-model";
import { createHostMessage, parseCanvasMessage, readCanvasErrorRetryable } from "./canvas-protocol";

/** `ready` 未到达的等待上限（设计 §5.4：10s 未就绪显示错误卡，且要区分「初始化超时 / 加载失败」）。 */
export const CANVAS_READY_TIMEOUT_MS = 10_000;

export interface CanvasHandshakeOptions {
  /** 上游 workflow ID；签发一次性 code 时作为 `workflowId`（与票据 `claims.wf` 一致）。 */
  readonly upstreamWorkflowId: string;
  /** 画布 iframe 的 URL；null 表示上游未就绪、iframe 未挂载，此时本 hook 不发任何请求。 */
  readonly frameUrl: string | null;
  /** 画布内的返回/跳转请求（`navigate-out`）：交宿主路由处理，不允许 iframe 自行整页跳转（设计 §5.4）。 */
  readonly onNavigateOut: () => void;
}

export interface CanvasHandshake {
  readonly phase: CanvasFramePhase;
  /** iframe 重挂载键：重试时自增，强制重新加载画布文档。 */
  readonly frameKey: number;
  /** 画布 `error` 消息里的 `retryable`；其余失败固定可重试。 */
  readonly retryable: boolean;
  readonly iframeRef: RefObject<HTMLIFrameElement | null>;
  /** 复位到 `connecting` 并重挂载 iframe（错误卡与超时卡的唯一恢复入口）。 */
  retry(): void;
}

export function useCanvasHandshake(options: CanvasHandshakeOptions): CanvasHandshake {
  const { upstreamWorkflowId, frameUrl, onNavigateOut } = options;
  const [phase, setPhase] = useState<CanvasFramePhase>("connecting");
  const [frameKey, setFrameKey] = useState(0);
  const [retryable, setRetryable] = useState(true);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  /**
   * 画布窗口的稳定引用。
   *
   * 为什么不能只靠元素 ref：React 删除子树时**先摘掉 ref、再跑 effect cleanup**，卸载路径（离开页面、
   * 切组织）拿到的是 `null`，`signout` 就发不出去。这里在首次成功投递或收到画布消息时记下来，
   * 卸载清理因此仍有投递对象（文档即将销毁时这封信是尽力而为，票据撤销才是真正的收口动作）。
   */
  const canvasWindowRef = useRef<Window | null>(null);
  /** 当前票据（唯一持有方）；撤销后置 null。 */
  const ticketRef = useRef<CanvasTicket | null>(null);
  /** 进行中的凭据链路，防重复 `ready` 重开一次签发。 */
  const handshakeRef = useRef<Promise<void> | null>(null);
  /** 进行中的续期，防重复 `refresh-request`。 */
  const refreshRef = useRef<Promise<void> | null>(null);
  /** 卸载后不再改状态、不再发消息（在途请求的 abort 也挂在这里）。 */
  const abortRef = useRef<AbortController | null>(null);
  const disposedRef = useRef(false);
  /** 世代号：重试即换代，旧世代的异步续作一律丢弃（否则旧票据会被发给重挂载后的画布）。 */
  const generationRef = useRef(0);
  const navigateOutRef = useRef(onNavigateOut);

  useEffect(() => {
    navigateOutRef.current = onNavigateOut;
  }, [onNavigateOut]);

  /** 向画布发消息；固定 `targetOrigin` 为控制台自身 origin，**不用 `"*"`**（冻结 §7）。 */
  const postToCanvas = useCallback((type: "token" | "signout", payload: unknown) => {
    const target = iframeRef.current?.contentWindow ?? canvasWindowRef.current;
    if (!target) return;
    canvasWindowRef.current = target;
    target.postMessage(createHostMessage(type, payload), window.location.origin);
  }, []);

  const deliverToken = useCallback(
    (ticket: CanvasTicket) => {
      // 载荷字段（`apiBase` / `ticket` / `expiresAt`）与画布侧 `readHandshakePayload` 逐字对齐（冻结 §7）
      postToCanvas("token", { apiBase: CANVAS_API_BASE, ticket: ticket.ticket, expiresAt: ticket.expiresAt });
    },
    [postToCanvas],
  );

  /** 会话不可救：下发 `signout` 让画布进中性页，并切到覆盖层（冻结 §7）。 */
  const expireSession = useCallback(() => {
    ticketRef.current = null;
    postToCanvas("signout", {});
    setPhase("session-expired");
  }, [postToCanvas]);

  /** 取 code → 兑换 → 下发票据；任一步失败都只能由宿主收口（画布拿不到 token 会一直等）。 */
  const runCredentialChain = useCallback(async () => {
    const generation = generationRef.current;
    const signal = abortRef.current?.signal;
    try {
      const { code } = await unwrap(issueCanvasCode(upstreamWorkflowId, { signal }));
      const ticket = await unwrap(exchangeCanvasTicket(code, { signal }));
      if (disposedRef.current || generationRef.current !== generation) return;
      ticketRef.current = ticket;
      deliverToken(ticket);
      setPhase("interactive");
    } catch {
      // 失败原因不细分的理由：三种失败（签发被拒 / code 过期或已消费 / 上游不可达）对用户的下一步动作相同，
      // 都是「重试」；具体原因进不了界面（§9.3 不展示 raw message），细分只会变成死代码。
      if (disposedRef.current || generationRef.current !== generation) return;
      setRetryable(true);
      setPhase("handshake-failed");
    }
  }, [upstreamWorkflowId, deliverToken]);

  /** 续期：换新票后立刻下发 token（画布正在等它，最长 10s）。 */
  const runRefresh = useCallback(async () => {
    const generation = generationRef.current;
    const current = ticketRef.current;
    if (current === null) {
      expireSession();
      return;
    }
    try {
      const next = await unwrap(refreshCanvasTicket(current.ticket, { signal: abortRef.current?.signal }));
      if (disposedRef.current || generationRef.current !== generation) return;
      ticketRef.current = next;
      deliverToken(next);
    } catch {
      if (disposedRef.current || generationRef.current !== generation) return;
      expireSession();
    }
  }, [deliverToken, expireSession]);

  // 生命周期：挂载时准备取消信号；卸载（含切组织、登出——宿主的组织切换会导航并卸载本页）时撤销票据族
  // 并向画布下发 signout。撤销是尽力而为：页面正在销毁时浏览器可能中止在途请求，票据 TTL 是最终兜底。
  useEffect(() => {
    disposedRef.current = false;
    const controller = new AbortController();
    abortRef.current = controller;
    return () => {
      disposedRef.current = true;
      controller.abort();
      const current = ticketRef.current;
      ticketRef.current = null;
      postToCanvas("signout", {});
      if (current !== null) void revokeCanvasTicket(current.ticket);
    };
  }, [postToCanvas]);

  /** 初始化超时的定时器句柄；`ready` 到达即停表——之后的等待由握手链路自身的 8s 超时兜底。 */
  const readyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopReadyTimer = useCallback(() => {
    if (readyTimerRef.current === null) return;
    clearTimeout(readyTimerRef.current);
    readyTimerRef.current = null;
  }, []);

  // 初始化超时（设计 §5.4）：窗口从 iframe 挂载起算，`ready` 到达即停表。
  useEffect(() => {
    if (frameUrl === null || phase !== "connecting") return;
    stopReadyTimer();
    readyTimerRef.current = setTimeout(() => setPhase("timeout"), CANVAS_READY_TIMEOUT_MS);
    return stopReadyTimer;
  }, [frameUrl, phase, stopReadyTimer]);

  // iframe 自身的加载失败只能走**原生**监听器：React 的非委托事件按标签注册，`iframe` 只注册了 `load`，
  // 于是 `onError` 属性是一行静默失效的代码（实测该元素的 React 事件注册表里没有 `error__bubble`）。
  // 它与超时是两条不同的信号：网络层就到不了上游时画布永远不会发 `ready`，10s 后只能报「超时」。
  // biome-ignore lint/correctness/useExhaustiveDependencies: frameKey 是刻意的重触发信号——重挂载后必须把监听器挂到**新**元素上（同批 SiteFrame reloadKey / agent-mcp-dialog 同款）。
  useEffect(() => {
    if (frameUrl === null) return;
    const frame = iframeRef.current;
    if (frame === null) return;
    const handleError = () => {
      // 已经交互过再收到加载失败（子资源级错误）不覆盖可用的画布。
      setPhase((current) => (current === "interactive" ? current : "load-failed"));
    };
    frame.addEventListener("error", handleError);
    return () => frame.removeEventListener("error", handleError);
  }, [frameUrl, frameKey]);

  // 画布 → 宿主 的消息入口：只认本页 iframe 发出的、同源的、信封版本匹配的消息（冻结 §7）。
  useEffect(() => {
    if (frameUrl === null) return;
    const handleMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      if (event.origin !== window.location.origin) return;
      canvasWindowRef.current = frame.contentWindow;
      const message = parseCanvasMessage(event.data);
      if (message === null) return;
      if (message.type === "ready") {
        // 幂等：票据在手或链路在途时重复 ready 不重开一次签发（code 单次消费，重开只会白费一个 code）。
        if (ticketRef.current !== null || handshakeRef.current !== null) return;
        stopReadyTimer();
        setPhase("connecting");
        handshakeRef.current = runCredentialChain().finally(() => {
          handshakeRef.current = null;
        });
        return;
      }
      if (message.type === "refresh-request") {
        if (refreshRef.current !== null) return;
        refreshRef.current = runRefresh().finally(() => {
          refreshRef.current = null;
        });
        return;
      }
      if (message.type === "error") {
        setRetryable(readCanvasErrorRetryable(message.payload));
        setPhase("canvas-error");
        return;
      }
      if (message.type === "navigate-out") {
        navigateOutRef.current();
      }
      // 其余类型（`bound` / `resize` / 未知）：本页不消费——`bound` 是 `bind` 路径的回执（本页不走该路径），
      // `resize` 面向「iframe 高度随内容变化」的宿主，本页是全高布局（设计 §6.2）。
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [frameUrl, runCredentialChain, runRefresh, stopReadyTimer]);

  const retry = useCallback(() => {
    const stale = ticketRef.current;
    ticketRef.current = null;
    handshakeRef.current = null;
    generationRef.current += 1;
    // 重试 = 换一个会话：旧票据族不再需要（画布会重新握手拿到新 sid），提前撤销而不是等 TTL 到期。
    if (stale !== null) void revokeCanvasTicket(stale.ticket);
    setRetryable(true);
    setPhase("connecting");
    setFrameKey((key) => key + 1);
  }, []);

  return { phase, frameKey, retryable, iframeRef, retry };
}
