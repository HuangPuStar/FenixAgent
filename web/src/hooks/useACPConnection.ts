import { useEffect, useState } from "react";
import type { ACPClient } from "../acp/client";
import type { ConnectionState } from "../acp/types";

export interface UseACPConnectionResult {
  connectionState: ConnectionState;
  error: string | null;
}

/**
 * 订阅 ACP 连接状态。
 * 非 owning — 传入 client，hook 只管订阅 state 事件。
 */
export function useACPConnection(client: ACPClient): UseACPConnectionResult {
  const [connectionState, setConnectionState] = useState<ConnectionState>(client.state.connectionState);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handler = ({ state, error: err }: { state: ConnectionState; error?: string }) => {
      setConnectionState(state);
      setError(err ?? null);
    };
    client.state.on("connectionStateChange", handler);
    return () => {
      client.state.off("connectionStateChange", handler);
    };
  }, [client]);

  return { connectionState, error };
}
