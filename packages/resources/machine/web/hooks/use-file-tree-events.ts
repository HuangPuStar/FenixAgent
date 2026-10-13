import { useCallback, useEffect, useRef } from "react";
import { type FileEventsConnection, openFileEventsConnection } from "../api/file-events";
import { revalidateWorkspaceTree } from "../api/fs";

interface UseFileTreeEventsOptions {
  envId: string | null;
  applyTree: (paths: string[], mtimes?: Record<string, number>) => void;
  onUnavailable: (error: unknown) => void;
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
export function useFileTreeEvents({ envId, applyTree, onUnavailable }: UseFileTreeEventsOptions) {
  const etagRef = useRef<string | null>(null);
  const revalidateTimerRef = useRef<number | null>(null);
  const lastRevalidateAtRef = useRef(0);
  const connectionRef = useRef<FileEventsConnection | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const shouldReconnectRef = useRef(false);

  const revalidateTree = useCallback(async () => {
    if (!envId) return;
    const now = Date.now();
    if (now - lastRevalidateAtRef.current < 30_000) return;
    lastRevalidateAtRef.current = now;
    try {
      // 条件请求与 304/ETag 处理在域模块（同包 `api/fs.ts` 的 fs 客户端）内完成，这里只消费结果：
      // not-modified 保留上一份可用树，updated 用新指纹与快照更新。
      const result = await revalidateWorkspaceTree(envId, etagRef.current);
      if (result.status === "not-modified") return;
      etagRef.current = result.etag;
      applyTree(result.tree.paths, result.tree.mtimes);
    } catch (error) {
      onUnavailable(error);
    }
  }, [applyTree, envId, onUnavailable]);

  const scheduleRevalidate = useCallback(
    (delay: number) => {
      if (revalidateTimerRef.current !== null) window.clearTimeout(revalidateTimerRef.current);
      revalidateTimerRef.current = window.setTimeout(() => {
        revalidateTimerRef.current = null;
        void revalidateTree();
      }, delay);
    },
    [revalidateTree],
  );

  const connect = useCallback(() => {
    if (!envId) return;
    shouldReconnectRef.current = true;
    if (connectionRef.current?.isOpen()) return;
    connectionRef.current?.close();
    const connection = openFileEventsConnection(envId, {
      onOpen: () => {
        reconnectAttemptRef.current = 0;
        void revalidateTree();
      },
      onFrame: (frame) => scheduleRevalidate(frame.kind === "invalidate_all" ? 0 : REVALIDATE_DEBOUNCE_MS),
      onClose: () => {
        if (connectionRef.current !== connection) return;
        connectionRef.current = null;
        if (!shouldReconnectRef.current) return;
        const delay = Math.min(3_000 * 2 ** reconnectAttemptRef.current, 30_000);
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      },
    });
    connectionRef.current = connection;
  }, [envId, revalidateTree, scheduleRevalidate]);

  useEffect(() => {
    if (!envId) return;
    connect();
    const onVisible = () =>
      document.visibilityState === "visible" && (connectionRef.current ? scheduleRevalidate(0) : connect());
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      shouldReconnectRef.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      connectionRef.current?.close();
      connectionRef.current = null;
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      if (revalidateTimerRef.current !== null) window.clearTimeout(revalidateTimerRef.current);
    };
  }, [connect, envId, scheduleRevalidate]);
}
