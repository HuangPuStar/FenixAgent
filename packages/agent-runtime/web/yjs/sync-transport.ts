// 默认启用的隔离 transport：二进制 JSON 握手，重连重建镜像，错误由 hook 判定回退。
import {
  createSyncClientTransport,
  type SyncClientTransport,
  type SyncClientTransportOptions,
} from "@fenix/chat-channel/sync-client";
import * as Y from "yjs";
import type {
  SyncChatConnectionState,
  SyncChatSession,
  SyncChatSessionOptions,
  SyncManifestSummary,
} from "./sync-chat-state";
import { INITIAL_SYNC_CHAT_STATE } from "./sync-chat-state";
import { createSyncContentProjectionHub, parseContentDocId, type SyncContentProjectionHub } from "./sync-doc-hub";
import {
  buildSyncChatSocketUrl,
  createBrowserSyncSocket,
  decodeSyncBase64Payload,
  decodeSyncWireJson,
  resolveYjsWsCloseOutcome,
  type SyncBrowserSocket,
  syncSocketBytes,
} from "./yjs-ws";

/** 与 `sync/protocol/frames.ts` 的 `SYNC_PROTOCOL_VERSION` 对齐（帧层不向浏览器出口暴露该常量）。 */
const SYNC_PROTOCOL_VERSION = 1;

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
  let retainedDocs = new Set<string>();
  let seenDeliveries = new Set<string>();
  let manifest: SyncManifestSummary | null = null;
  let directoryDoc: Y.Doc | null = null;
  let manifestHandled = false;
  let expectedGeneration: string | null = options.generation ?? null;
  let reconnectAttempt = 0;
  let reconnectCancel: (() => void) | null = null;
  let connecting = false;
  let fatal = false;
  let disposed = false;
  let driveScheduled = false;

  function createProjectionHub(): SyncContentProjectionHub {
    return createSyncContentProjectionHub({
      onProjection: (projection) => {
        if (!disposed) options.onProjection?.(projection);
      },
    });
  }

  function setState(patch: Partial<SyncChatConnectionState>): void {
    if (disposed) return;
    state = { ...state, ...patch };
    options.onState?.(state);
  }

  function sendBytes(bytes: Uint8Array): boolean {
    const current = socket;
    if (current === null || current.readyState !== 1) return false;
    if (current.bufferedAmount > 64 * 1024) return false;
    try {
      current.send(bytes);
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
    retainedDocs = new Set<string>();
    seenDeliveries = new Set<string>();
  }

  function teardownTransport(): void {
    releaseRetainedDocs();
    transport?.dispose();
    transport = null;
    manifestHandled = false;
  }

  function fail(code: string, message: string): void {
    if (disposed) return;
    fatal = true;
    setState({ status: "error", error: { code, message } });
    teardownTransport();
    const current = socket;
    socket = null;
    if (current !== null) {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      try {
        current.close(1002, "sync protocol error");
      } catch {}
    }
  }

  function tapContentFrame(bytes: Uint8Array): void {
    const frame = decodeSyncWireJson(bytes);
    if (frame === null) return;
    const type = frame.type;
    if (type !== "DOC_BASE" && type !== "DOC_UPDATE") return;
    if (frame.protocolVersion !== SYNC_PROTOCOL_VERSION) return;
    if (typeof frame.docId !== "string" || typeof frame.generation !== "string" || typeof frame.payload !== "string") {
      return;
    }
    const parsedDoc = parseContentDocId(frame.docId);
    if (parsedDoc === null || !retainedDocs.has(frame.docId)) return;
    if (expectedGeneration !== null && frame.generation !== expectedGeneration) return;
    const deliveryId = typeof frame.deliveryId === "string" ? frame.deliveryId : null;
    if (deliveryId !== null) {
      if (seenDeliveries.has(deliveryId)) return;
      seenDeliveries.add(deliveryId);
      if (seenDeliveries.size > 4096) {
        const oldest = seenDeliveries.values().next();
        if (!oldest.done) seenDeliveries.delete(oldest.value);
      }
    }
    const payload = decodeSyncBase64Payload(frame.payload);
    if (payload === null) return;
    if (typeof frame.encodedLength === "number" && frame.encodedLength !== payload.byteLength) return;
    projectionHub.applyUpdate({ docId: frame.docId, generation: frame.generation, payload });
  }

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

  function tapDirectoryFrame(bytes: Uint8Array): void {
    const frame = decodeSyncWireJson(bytes);
    const activeManifest = manifest;
    if (
      frame === null ||
      activeManifest === null ||
      (frame.type !== "DOC_BASE" && frame.type !== "DOC_UPDATE") ||
      frame.docId !== activeManifest.directoryDocId ||
      frame.generation !== activeManifest.generation ||
      typeof frame.payload !== "string"
    ) {
      return;
    }
    const payload = decodeSyncBase64Payload(frame.payload);
    if (payload === null) return;
    try {
      if (directoryDoc === null) directoryDoc = new Y.Doc();
      Y.applyUpdate(directoryDoc, payload);
      const discovered = contentDocIdsFromDirectory().filter(
        (docId) => parseContentDocId(docId)?.generation === manifest?.generation && !retainedDocs.has(docId),
      );
      if (discovered.length === 0 || transport === null) return;
      for (const docId of discovered) {
        transport.hub.retain(docId);
        retainedDocs.add(docId);
      }
      if (!sendSubscribe(discovered, "currentHistory")) {
        fail("CAPACITY_EXCEEDED", "socket is saturated while sending content SUBSCRIBE");
      } else {
        setState({ subscribedDocIds: Object.freeze([...state.subscribedDocIds, ...discovered]) });
      }
    } catch (error) {
      fail("MALFORMED_FRAME", error instanceof Error ? error.message : "failed to apply directory update");
    }
  }

  function handleInboundBytes(bytes: Uint8Array): void {
    if (disposed) return;
    tapDirectoryFrame(bytes);
    tapContentFrame(bytes);
    const active = transport;
    if (active === null) return;
    active.onFrame(bytes);
    scheduleDrive();
  }

  function handleInboundData(data: unknown): void {
    if (typeof data === "string") {
      // 新协议要求二进制 JSON；收到文本帧说明对端仍在旧协议上，必须显式失败而不是静默重试。
      fail("MALFORMED_FRAME", "new sync protocol requires binary frames");
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

  function contentDocIdsFromDirectory(): string[] {
    const value = directoryDoc?.getMap<unknown>("root").get("contentDocIds");
    if (value instanceof Y.Array) {
      return value.toArray().filter((docId): docId is string => typeof docId === "string");
    }
    return Array.isArray(value) ? value.filter((docId): docId is string => typeof docId === "string") : [];
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
    const nextDocIds = [...new Set([...entryDocIds, ...debugContentDocIds])];
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
    directoryDoc?.destroy();
    directoryDoc = new Y.Doc();
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

    try {
      for (const docId of nextDocIds) {
        transport.hub.retain(docId);
        retainedDocs.add(docId);
      }
    } catch (error) {
      fail("MALFORMED_FRAME", error instanceof Error ? error.message : "failed to retain sync doc");
      return;
    }

    if (!sendSubscribe(entryDocIds, "live") || !sendSubscribe(debugContentDocIds, "currentHistory")) {
      fail("CAPACITY_EXCEEDED", "socket is saturated while sending SUBSCRIBE");
      return;
    }
    reconnectAttempt = 0;
    setState({
      status: "ready",
      error: null,
      generation: input.generation,
      manifest,
      subscribedDocIds: Object.freeze(nextDocIds),
      reconnectAttempt: 0,
    });
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
    setState({ status: "reconnecting", reconnectAttempt });
    reconnectCancel = schedule(() => {
      reconnectCancel = null;
      connect();
    }, delay);
  }

  function handleClose(current: SyncBrowserSocket, code: number, reason: string): void {
    if (socket !== current) return;
    socket = null;
    connecting = false;
    teardownTransport();
    if (disposed) return;
    if (fatal) {
      setState({ status: "error" });
      return;
    }
    if (SYNC_TERMINAL_CLOSE_CODES.has(code)) {
      setState({ status: "error", error: { code: `WS_${code}`, message: reason || `websocket closed (${code})` } });
      return;
    }
    const outcome = resolveYjsWsCloseOutcome(code, reason);
    if (outcome.terminal) {
      setState({
        status: "closed",
        error: outcome.uiCode === null ? null : { code: outcome.uiCode, message: reason || outcome.uiCode },
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
    projectionHub.dispose();
    projectionHub = createProjectionHub();
    projectionHub.reset(expectedGeneration);
    setState({
      status: reconnectAttempt > 0 ? "reconnecting" : "connecting",
      error: null,
      reconnectAttempt,
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
    current.onclose = (code, reason) => handleClose(current, code, reason);
    current.onerror = () => {
      if (socket === current) setState({ error: { code: "SOCKET_ERROR", message: "websocket error" } });
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
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
        current.close(1000, "dispose");
      } catch {}
    }
    teardownTransport();
    projectionHub.dispose();
    directoryDoc?.destroy();
    directoryDoc = null;
  }

  return { connect, dispose, state: () => state };
}
