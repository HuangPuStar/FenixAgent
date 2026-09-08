import { useCallback, useEffect, useRef } from "react";

interface UseFileTreeEventsOptions {
  envId: string | null;
  applyTree: (paths: string[], mtimes?: Record<string, number>) => void;
  onUnavailable: (error: unknown) => void;
}

/** Subscribe to remote workspace invalidations while preserving the last good tree during outages. */
export function useFileTreeEvents({ envId, applyTree, onUnavailable }: UseFileTreeEventsOptions) {
  const etagRef = useRef<string | null>(null);
  const revalidateTimerRef = useRef<number | null>(null);
  const lastRevalidateAtRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const shouldReconnectRef = useRef(false);

  const revalidateTree = useCallback(async () => {
    if (!envId) return;
    const now = Date.now();
    if (now - lastRevalidateAtRef.current < 30_000) return;
    lastRevalidateAtRef.current = now;
    try {
      const headers: Record<string, string> = {};
      if (etagRef.current) headers["If-None-Match"] = etagRef.current;
      const response = await fetch(`/web/environments/${encodeURIComponent(envId)}/fs/tree`, {
        credentials: "include",
        headers,
      });
      if (response.status === 304) return;
      if (!response.ok) throw new Error(`Tree revalidate failed: ${response.status}`);
      const payload = (await response.json()) as {
        success?: boolean;
        data?: { paths?: string[]; mtimes?: Record<string, number> };
      };
      if (payload.success === false) throw new Error("Tree revalidate rejected");
      etagRef.current = response.headers.get("etag");
      applyTree(payload.data?.paths ?? [], payload.data?.mtimes);
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
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    wsRef.current?.close();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const organizationId = localStorage.getItem("active_org_id");
    const query = organizationId ? `?active_org_id=${encodeURIComponent(organizationId)}` : "";
    const socket = new WebSocket(`${protocol}//${window.location.host}/web/file-events${query}`);
    wsRef.current = socket;
    socket.onopen = () => {
      reconnectAttemptRef.current = 0;
      socket.send(JSON.stringify({ type: "subscribe", environments: [envId] }));
      void revalidateTree();
    };
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as { type?: string; environment_id?: string };
        if (frame.environment_id !== envId) return;
        if (frame.type === "invalidate_all") {
          scheduleRevalidate(0);
        } else if (frame.type === "file_changed" || frame.type === "file_changed_batch") {
          scheduleRevalidate(500);
        }
      } catch (error) {
        console.error("Invalid file-events frame:", error);
      }
    };
    socket.onclose = () => {
      if (wsRef.current !== socket) return;
      wsRef.current = null;
      if (!shouldReconnectRef.current) return;
      const delay = Math.min(3_000 * 2 ** reconnectAttemptRef.current, 30_000);
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = window.setTimeout(connect, delay);
    };
  }, [envId, revalidateTree, scheduleRevalidate]);

  useEffect(() => {
    if (!envId) return;
    connect();
    const onVisible = () =>
      document.visibilityState === "visible" && (wsRef.current ? scheduleRevalidate(0) : connect());
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      shouldReconnectRef.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      wsRef.current?.close();
      wsRef.current = null;
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      if (revalidateTimerRef.current !== null) window.clearTimeout(revalidateTimerRef.current);
    };
  }, [connect, envId, scheduleRevalidate]);
}
