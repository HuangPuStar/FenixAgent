// 默认启用的隔离 transport：二进制 JSON 握手，重连重建镜像，错误由 hook 判定回退。
import {
  createSyncClientTransport,
  type SyncClientTransport,
  type SyncClientTransportOptions,
} from "@fenix/chat-channel/sync-client";
import type {
  SyncChatConnectionState,
  SyncChatSession,
  SyncChatSessionOptions,
  SyncManifestSummary,
} from "./sync-chat-state";
import { INITIAL_SYNC_CHAT_STATE, SYNC_PROTOCOL_VERSION } from "./sync-chat-state";
import { formatSyncCloseError, logSyncClose } from "./sync-close-diagnostic";
import { createSyncContentSubscription, type SyncContentSubscription } from "./sync-content-subscription";
import { createSyncContentTap, noteProcessedAck } from "./sync-content-tap";
import {
  createSyncContentProjectionHub,
  parseContentDocId,
  SYNC_PROJECTION_MESSAGE_STEP,
  type SyncContentProjectionHub,
} from "./sync-doc-hub";
import { createSyncFrameRouter } from "./sync-frame-router";
import { createSyncHydrationTracker } from "./sync-hydration-tracker";
import {
  buildSyncChatSocketUrl,
  createBrowserSyncSocket,
  decodeSyncWireJson,
  resolveYjsWsCloseOutcome,
  type SyncBrowserSocket,
  syncSocketBytes,
} from "./yjs-ws";

const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 10000] as const;

/** 新协议专属终态关闭码：服务端明确拒绝/无法承载该协议时不再重连（1006 等网络断开仍退避重试）。 */
const SYNC_TERMINAL_CLOSE_CODES: ReadonlySet<number> = new Set([1002, 1003, 1008, 1009, 1011]);

export type {
  SyncChatConnectionState,
  SyncChatSession,
  SyncChatSessionOptions,
  SyncChatStatus,
  SyncManifestSummary,
} from "./sync-chat-state";
export { INITIAL_SYNC_CHAT_STATE } from "./sync-chat-state";

type SyncControlFrame = Parameters<NonNullable<SyncClientTransportOptions["onControl"]>>[0];
type ManifestFrame = Extract<SyncControlFrame, { type: "MANIFEST" }>;
type GenerationReplaceFrame = Extract<SyncControlFrame, { type: "GENERATION_REPLACE" }>;

const UTF8_ENCODER = new TextEncoder();

export function createSyncChatSession(options: SyncChatSessionOptions): SyncChatSession {
  const reconnectDelays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  const schedule =
    options.schedule ??
    ((task: () => void, delayMs: number): (() => void) => {
      const handle = setTimeout(task, delayMs);
      return () => clearTimeout(handle);
    });
  const yieldToHost = options.yieldToHost ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const socketFactory = options.socketFactory ?? createBrowserSyncSocket;
  const contentDocIds = [...new Set(options.contentDocIds ?? [])];
  const url =
    options.url ??
    buildSyncChatSocketUrl(options.agentId, {
      instanceUid: options.instanceUid,
      rcsSessionId: options.rcsSessionId,
    });

  let state: SyncChatConnectionState = INITIAL_SYNC_CHAT_STATE;
  let socket: SyncBrowserSocket | null = null;
  let transport: SyncClientTransport | null = null;
  let projectionHub: SyncContentProjectionHub = createProjectionHub();
  const retainedDocs = new Set<string>();
  const seenDeliveries = new Set<string>();
  let manifest: SyncManifestSummary | null = null;
  let manifestHandled = false;
  let expectedGeneration: string | null = options.generation ?? null;
  let reconnectAttempt = 0;
  let reconnectCancel: (() => void) | null = null;
  let connecting = false;
  let fatal = false;
  let localClose = false;
  let disposed = false;
  let driveScheduled = false;
  let contentSubscription: SyncContentSubscription | null = null;
  function createProjectionHub(): SyncContentProjectionHub {
    return createSyncContentProjectionHub({
      onProjection: (projection) => {
        contentSubscription?.refreshHistoryState(projection.hiddenMessageCount);
        if (!disposed) options.onProjection?.(projection);
      },
    });
  }
  function setState(patch: Partial<SyncChatConnectionState>): void {
    if (disposed) return;
    state = { ...state, ...patch };
    options.onState?.(state);
  }
  const hydration = createSyncHydrationTracker({
    onHydratingChange: (hydrating) => setState({ hydrating }),
    timeoutMs: options.syncBaseTimeoutMs,
  });
  function sendBytes(bytes: Uint8Array): boolean {
    const current = socket;
    if (current === null || current.readyState !== 1) return false;
    if (current.bufferedAmount > 64 * 1024) return false;
    try {
      current.send(bytes);
      noteProcessedAck(bytes, hydration);
      return true;
    } catch {
      return false;
    }
  }
  function sendFrame(frame: Record<string, unknown>): boolean {
    return sendBytes(UTF8_ENCODER.encode(JSON.stringify(frame)));
  }
  function releaseRetainedDocs(): void {
    if (transport !== null) {
      for (const docId of retainedDocs) {
        try {
          transport.hub.release(docId);
        } catch {
          // 重连清理忽略已释放条目。
        }
      }
    }
    retainedDocs.clear();
    seenDeliveries.clear();
  }
  function releaseSharedDoc(docId: string): void {
    // 先释放协议侧的 retain 计数，再销毁只读投影镜像；两步都允许对已释放条目幂等。
    retainedDocs.delete(docId);
    try {
      transport?.hub.release(docId);
    } catch {
      // 连接拆除期间可能已释放，忽略。
    }
    projectionHub.release(docId);
    if (state.subscribedDocIds.includes(docId)) {
      setState({
        subscribedDocIds: Object.freeze(state.subscribedDocIds.filter((item) => item !== docId)),
      });
    }
  }
  function retainSharedDoc(docId: string): void {
    if (transport === null) throw new Error("sync transport is not ready");
    transport.hub.retain(docId);
    retainedDocs.add(docId);
  }
  function teardownTransport(): void {
    releaseRetainedDocs();
    contentSubscription?.reset();
    frameRouter.resetDirectory();
    hydration.reset();
    transport?.dispose();
    transport = null;
    manifestHandled = false;
  }
  function fail(code: string, message: string): void {
    if (disposed) return;
    fatal = true;
    setState({ status: "error", error: { code, message }, hydrating: false });
    teardownTransport();
    const current = socket;
    socket = null;
    if (current !== null) {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      try {
        localClose = true;
        current.close(1002, "sync protocol error");
      } catch {}
    }
  }
  const tapContentFrame = createSyncContentTap({
    retainedDocs,
    seenDeliveries,
    expectedGeneration: () => expectedGeneration,
    applyProjection: (input) => projectionHub.applyUpdate(input),
    hydration,
    onBase: (docId) => contentSubscription?.noteBase(docId),
  });
  contentSubscription = createSyncContentSubscription({
    retainedDocs,
    hydration,
    subscribe: sendSubscribe,
    retainDoc: retainSharedDoc,
    releaseDoc: (docId) => {
      releaseSharedDoc(docId);
      // 内容块被窗口淘汰后，包含它的页镜像若已无驻留块也应同步释放。
      frameRouter.prunePageMirrors();
    },
    onSubscribed: (docIds) => {
      const next = [...new Set([...state.subscribedDocIds, ...docIds])];
      if (next.length !== state.subscribedDocIds.length) setState({ subscribedDocIds: Object.freeze(next) });
    },
    onHistoryState: ({ hasEarlier, loading }) => {
      if (state.hasEarlierHistory === hasEarlier && state.historyLoading === loading) return;
      setState({ hasEarlierHistory: hasEarlier, historyLoading: loading });
    },
    hiddenMessageCount: () => projectionHub.snapshot().hiddenMessageCount,
    growProjectionWindow: () => projectionHub.growWindow(SYNC_PROJECTION_MESSAGE_STEP),
    hasEarlierPages: () => frameRouter.hasEarlierPage(),
    requestEarlierPage: () => frameRouter.requestEarlierPage(),
    fail,
  });
  function scheduleDrive(): void {
    if (disposed || driveScheduled) return;
    driveScheduled = true;
    void (async () => {
      try {
        // 旧调度判空后入队的任务必须再跑一轮，否则 ACK 会挂到下一帧。
        const active = transport;
        while (!disposed && active !== null) {
          await active.drain();
          if (transport !== active || active.hub.queueDepth() === 0) break;
        }
      } catch (error) {
        fail("MALFORMED_FRAME", error instanceof Error ? error.message : "sync drain failed");
      } finally {
        driveScheduled = false;
      }
      if (!disposed && (transport?.hub.queueDepth() ?? 0) > 0) scheduleDrive();
    })();
  }
  const frameRouter = createSyncFrameRouter({
    hydration,
    getManifest: () => manifest,
    getContentSubscription: () => contentSubscription,
    retainedDocs,
    retainDoc: retainSharedDoc,
    releaseDoc: releaseSharedDoc,
    subscribe: sendSubscribe,
    fail,
  });
  function handleInboundBytes(bytes: Uint8Array): void {
    if (disposed) return;
    // 同一帧只解码一次：directory/content 旁路与协议 transport 都需要结构化视图。
    const frame = decodeSyncWireJson(bytes);
    if (frame === null) {
      // 新协议帧必须是 UTF-8 JSON（首字节 `{`）；其余二进制帧属于旧 Yjs 通道，直接忽略。
      // `{` 开头但 JSON 非法的帧仍交给 transport 产生 MALFORMED_FRAME，避免掩盖损坏。
      if (bytes.byteLength === 0 || bytes[0] !== 0x7b) return;
    } else {
      frameRouter.tapDirectoryFrame(frame);
      tapContentFrame(frame);
    }
    const active = transport;
    if (active === null) return;
    active.onFrame(bytes);
    scheduleDrive();
  }
  function handleInboundData(data: unknown): void {
    if (typeof data === "string") {
      // 旧通道控制文本（yjs:sync-request/keep_alive/pong/action ack）与新协议共用 endpoint；
      // 新协议只认二进制，文本帧属于旧通道，忽略而不是误判 MALFORMED_FRAME。
      return;
    }
    const bytes = syncSocketBytes(data);
    if (bytes !== null) {
      handleInboundBytes(bytes);
      return;
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      void data
        .arrayBuffer()
        .then((buffer) => handleInboundBytes(new Uint8Array(buffer)))
        .catch(() => fail("MALFORMED_FRAME", "failed to read binary frame"));
    }
  }
  function sendSubscribe(docIds: readonly string[], priority: "live" | "currentHistory"): boolean {
    if (docIds.length === 0) return true;
    return sendFrame({ type: "SUBSCRIBE", protocolVersion: SYNC_PROTOCOL_VERSION, docIds, priority });
  }
  function applyManifest(input: ManifestFrame | GenerationReplaceFrame): void {
    if (input.protocolVersion !== SYNC_PROTOCOL_VERSION) {
      fail("PROTOCOL_VERSION_UNSUPPORTED", `unsupported sync protocol version ${String(input.protocolVersion)}`);
      return;
    }
    const entryDocIds = [input.controlDocId, input.runtimeDocId, input.directoryDocId];
    // 显式注入仅作调试后备；联调默认空值，内容块由目录 Doc 权威发现。
    const debugContentDocIds = contentDocIds.filter(
      (docId) => parseContentDocId(docId)?.generation === input.generation,
    );
    const unchanged =
      manifestHandled &&
      manifest !== null &&
      manifest.generation === input.generation &&
      manifest.controlDocId === input.controlDocId &&
      manifest.runtimeDocId === input.runtimeDocId &&
      manifest.directoryDocId === input.directoryDocId &&
      manifest.pointerRevision === input.pointerRevision &&
      manifest.referenceRevision === input.referenceRevision;
    if (unchanged) return;
    if (transport === null) {
      fail("INTERNAL_ERROR", "manifest received before the sync transport was created");
      return;
    }

    releaseRetainedDocs();
    contentSubscription?.reset();
    frameRouter.resetDirectory();
    expectedGeneration = input.generation;
    manifestHandled = true;
    manifest = {
      generation: input.generation,
      pointerRevision: input.pointerRevision,
      referenceRevision: input.referenceRevision,
      controlDocId: input.controlDocId,
      runtimeDocId: input.runtimeDocId,
      directoryDocId: input.directoryDocId,
      recoveryState: input.type === "MANIFEST" ? input.recoveryState : null,
    };
    projectionHub.reset(input.generation);
    // 首批 DOC_BASE（入口 Doc + 窗口内内容块）落地前不提交半成品；更早块不进入首批等待。
    hydration.begin(entryDocIds);

    try {
      for (const docId of entryDocIds) {
        transport.hub.retain(docId);
        retainedDocs.add(docId);
      }
    } catch (error) {
      fail("MALFORMED_FRAME", error instanceof Error ? error.message : "failed to retain sync doc");
      return;
    }

    if (!sendSubscribe(entryDocIds, "live")) {
      fail("CAPACITY_EXCEEDED", "socket is saturated while sending SUBSCRIBE");
      return;
    }
    reconnectAttempt = 0;
    setState({
      status: "ready",
      error: null,
      generation: input.generation,
      manifest,
      subscribedDocIds: Object.freeze(entryDocIds),
      hasEarlierHistory: false,
      historyLoading: false,
      reconnectAttempt: 0,
    });
    // 调试后备内容块同样只订阅窗口内的最近块；目录到达后会再次按权威顺序裁决。
    if (debugContentDocIds.length > 0) contentSubscription?.applyDirectory(debugContentDocIds, true);
  }
  function handleControl(frame: SyncControlFrame): void {
    switch (frame.type) {
      case "MANIFEST":
        applyManifest(frame);
        return;
      case "GENERATION_REPLACE": {
        if (
          manifestHandled &&
          manifest !== null &&
          frame.generation === manifest.generation &&
          frame.pointerRevision <= manifest.pointerRevision
        ) {
          return;
        }
        applyManifest(frame);
        return;
      }
      case "ERROR":
        fail(frame.code, frame.message ?? frame.code);
        return;
      default:
        return;
    }
  }
  function sendHello(): void {
    const generation = manifest?.generation ?? expectedGeneration;
    const hello: Record<string, unknown> = {
      type: "HELLO",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      scope: { organizationId: options.organizationId, rcsSessionId: options.rcsSessionId },
      loadedDocs: [],
      stateful: false,
    };
    if (generation !== null && generation !== undefined) hello.generation = generation;
    if (!sendFrame(hello)) {
      fail("CAPACITY_EXCEEDED", "socket is saturated while sending HELLO");
    }
  }
  function scheduleReconnect(): void {
    if (disposed || fatal) return;
    if (options.autoReconnect === false) {
      setState({ status: "closed" });
      return;
    }
    const delay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)] ?? 10000;
    reconnectAttempt += 1;
    setState({ status: "reconnecting", reconnectAttempt, hydrating: false });
    reconnectCancel = schedule(() => {
      reconnectCancel = null;
      connect();
    }, delay);
  }
  function handleClose(current: SyncBrowserSocket, code: number, reason: string, wasClean: boolean): void {
    if (socket !== current) return;
    socket = null;
    connecting = false;
    const local = localClose;
    const clean = wasClean === true;
    localClose = false;
    logSyncClose({ code, reason, wasClean: clean, local });
    teardownTransport();
    if (disposed) return;
    if (fatal) {
      setState({ status: "error", hydrating: false });
      return;
    }
    if (SYNC_TERMINAL_CLOSE_CODES.has(code)) {
      setState({
        status: "error",
        error: formatSyncCloseError({ code: `WS_${code}`, reason, wasClean: clean, local }),
        hydrating: false,
      });
      return;
    }
    const outcome = resolveYjsWsCloseOutcome(code, reason);
    if (outcome.terminal) {
      setState({
        status: "closed",
        error:
          outcome.uiCode === null
            ? null
            : formatSyncCloseError({ code: outcome.uiCode, reason, wasClean: clean, local }),
        hydrating: false,
      });
      return;
    }
    scheduleReconnect();
  }
  function connect(): void {
    if (disposed || connecting || socket !== null) return;
    connecting = true;
    fatal = false;
    reconnectCancel?.();
    reconnectCancel = null;
    teardownTransport();
    // 连接级 runtime/store 不跨连接：重连必须 stateless HELLO，不能复用上一代 generation（1008）。
    manifest = null;
    expectedGeneration = options.generation ?? null;
    projectionHub.dispose();
    projectionHub = createProjectionHub();
    projectionHub.reset(expectedGeneration);
    setState({
      status: reconnectAttempt > 0 ? "reconnecting" : "connecting",
      error: null,
      reconnectAttempt,
      hydrating: false,
      manifest: null,
      generation: expectedGeneration,
    });

    let current: SyncBrowserSocket;
    try {
      current = socketFactory(url);
    } catch (error) {
      connecting = false;
      fail("SOCKET_CONNECT_FAILED", error instanceof Error ? error.message : "failed to create websocket");
      return;
    }
    socket = current;
    current.binaryType = "arraybuffer";
    current.onopen = () => {
      if (socket !== current || disposed) return;
      connecting = false;
      transport = createSyncClientTransport({
        send: sendBytes,
        now: options.now ?? Date.now,
        yieldToHost,
        onControl: handleControl,
        onFatal: (code, detail) => fail(code, detail ?? code),
      });
      setState({ status: "handshaking" });
      sendHello();
    };
    current.onmessage = (data) => {
      if (socket !== current || disposed) return;
      handleInboundData(data);
    };
    current.onclose = (code, reason, wasClean) => handleClose(current, code, reason, wasClean);
    current.onerror = () => {
      if (socket === current) setState({ error: { code: "SOCKET_ERROR", message: "websocket error" } });
    };
  }
  function loadEarlierHistory(): boolean {
    if (disposed || contentSubscription === null) return false;
    const generation = manifest?.generation ?? expectedGeneration;
    const directoryContentDocIds = frameRouter
      .readContentDocIds()
      .filter((docId) => parseContentDocId(docId)?.generation === generation);
    const fallbackContentDocIds = contentDocIds.filter((docId) => parseContentDocId(docId)?.generation === generation);
    return contentSubscription.loadEarlier(
      directoryContentDocIds.length > 0 ? directoryContentDocIds : fallbackContentDocIds,
    );
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    hydration.dispose();
    reconnectCancel?.();
    reconnectCancel = null;
    const current = socket;
    socket = null;
    if (current !== null) {
      current.onopen = null;
      current.onmessage = null;
      current.onclose = null;
      current.onerror = null;
      try {
        localClose = true;
        current.close(1000, "dispose");
      } catch {}
    }
    teardownTransport();
    projectionHub.dispose();
    frameRouter.dispose();
  }

  return { connect, dispose, state: () => state, loadEarlierHistory };
}
