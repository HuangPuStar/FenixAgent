import { useCallback, useEffect, useRef } from "react";
import { type FileEventsConnection, openFileEventsConnection } from "../api/file-events";
import { revalidateWorkspaceTree } from "../api/fs";

interface UseFileTreeEventsOptions {
  envId: string | null;
  applyTree: (paths: string[], mtimes?: Record<string, number>, sizes?: Record<string, number>) => void;
  onUnavailable: (error: unknown) => void;
  onFileChanged?: (change: { kind: "paths" | "invalidate-all"; paths: readonly string[] }) => void;
}

/** 连接存活时收到变更事件后的去抖窗口（毫秒）：批量变更合并成一次条件请求。 */
const REVALIDATE_DEBOUNCE_MS = 500;

/**
 * Subscribe to remote workspace invalidations while preserving the last good tree during outages.
 *
 * 归属（2026-09-24，台账 `ce-standards-todo.md` D2）：由宿主
 * `apps/web/src/shell/artifacts/use-file-tree-events.ts` 迁入（该簇 2026-09-28 归位到
 * `apps/web/src/pages/agent-panel/artifacts/`，本文件不在其中），两条依赖（条件请求客户端与 WS 通道）
 * 都已是本包模块，因此包内改用相对导入，不再经自身包名取数。
 */
export function useFileTreeEvents({ envId, applyTree, onUnavailable, onFileChanged }: UseFileTreeEventsOptions) {
  const onChangedRef = useRef(onFileChanged);
  onChangedRef.current = onFileChanged;
  const etagRef = useRef<string | null>(null);
  const revalidateTimerRef = useRef<number | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const connectionRef = useRef<FileEventsConnection | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const shouldReconnectRef = useRef(false);
  const scopeRef = useRef<object | null>(null);

  const revalidateTree = useCallback(async () => {
    if (!envId) return;
    const scope = scopeRef.current;
    if (!scope) return;
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    try {
      // 条件请求与 304/ETag 处理在域模块（同包 `api/fs.ts` 的 fs 客户端）内完成，这里只消费结果：
      // not-modified 保留上一份可用树，updated 用新指纹与快照更新。
      const result = await revalidateWorkspaceTree(envId, etagRef.current, request.signal);
      if (scopeRef.current !== scope || requestRef.current !== request || request.signal.aborted) return;
      if (result.status === "not-modified") return;
      etagRef.current = result.etag;
      applyTree(result.tree.paths, result.tree.mtimes, result.tree.sizes);
    } catch (error) {
      if (scopeRef.current === scope && requestRef.current === request && !request.signal.aborted) onUnavailable(error);
    } finally {
      if (requestRef.current === request) requestRef.current = null;
    }
  }, [applyTree, envId, onUnavailable]);

  const scheduleRevalidate = useCallback(
    (delay: number) => {
      const scope = scopeRef.current;
      if (revalidateTimerRef.current !== null) window.clearTimeout(revalidateTimerRef.current);
      revalidateTimerRef.current = window.setTimeout(() => {
        revalidateTimerRef.current = null;
        if (scopeRef.current === scope) void revalidateTree();
      }, delay);
    },
    [revalidateTree],
  );

  const connect = useCallback(() => {
    const scope = scopeRef.current;
    if (!envId || !scope) return;
    shouldReconnectRef.current = true;
    if (connectionRef.current?.isOpen()) return;
    connectionRef.current?.close();
    const connection = openFileEventsConnection(envId, {
      onOpen: () => {
        if (connectionRef.current !== connection || scopeRef.current !== scope) return;
        reconnectAttemptRef.current = 0;
        onChangedRef.current?.({ kind: "invalidate-all", paths: [] });
        void revalidateTree();
      },
      onFrame: (frame) => {
        if (connectionRef.current !== connection || scopeRef.current !== scope) return;
        onChangedRef.current?.({
          kind: frame.kind === "invalidate_all" ? "invalidate-all" : "paths",
          paths: frame.paths,
        });
        scheduleRevalidate(frame.kind === "invalidate_all" ? 0 : REVALIDATE_DEBOUNCE_MS);
      },
      onClose: () => {
        if (connectionRef.current !== connection || scopeRef.current !== scope) return;
        connectionRef.current = null;
        if (!shouldReconnectRef.current) return;
        const delay = Math.min(3_000 * 2 ** reconnectAttemptRef.current, 30_000);
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(() => {
          if (scopeRef.current === scope) connect();
        }, delay);
      },
    });
    connectionRef.current = connection;
  }, [envId, revalidateTree, scheduleRevalidate]);

  useEffect(() => {
    if (!envId) return;
    const scope = {};
    scopeRef.current = scope;
    etagRef.current = null;
    connect();
    const onVisible = () => {
      if (document.visibilityState !== "visible" || scopeRef.current !== scope) return;
      onChangedRef.current?.({ kind: "invalidate-all", paths: [] });
      if (connectionRef.current) scheduleRevalidate(0);
      else connect();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (scopeRef.current === scope) scopeRef.current = null;
      requestRef.current?.abort();
      requestRef.current = null;
      shouldReconnectRef.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      connectionRef.current?.close();
      connectionRef.current = null;
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      if (revalidateTimerRef.current !== null) window.clearTimeout(revalidateTimerRef.current);
    };
  }, [connect, envId, scheduleRevalidate]);
  /** A manual tree request supersedes the pending conditional revalidation. */
  const cancelRevalidation = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    if (revalidateTimerRef.current !== null) window.clearTimeout(revalidateTimerRef.current);
    revalidateTimerRef.current = null;
  }, []);
  return { cancelRevalidation };
}
