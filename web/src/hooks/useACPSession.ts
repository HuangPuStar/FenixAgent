import { useEffect, useState } from "react";
import type { ACPClient } from "../acp/client";
import type { AgentCapabilities } from "../acp/types";

export interface UseACPSessionResult {
  sessionId: string | null;
  capabilities: AgentCapabilities | null;
  supportsImages: boolean;
  supportsSessionHistory: boolean;
}

/**
 * 订阅 ACP session 状态和能力。
 * 非 owning — 传入 client，hook 只管订阅 state 事件。
 */
export function useACPSession(client: ACPClient): UseACPSessionResult {
  const [sessionId, setSessionId] = useState(client.state.sessionId);
  const [capabilities, setCapabilities] = useState(client.state.agentCapabilities);

  useEffect(() => {
    const onSessionId = (id: string | null) => setSessionId(id);
    const onCaps = (caps: AgentCapabilities | null) => setCapabilities(caps);

    client.state.on("sessionIdChange", onSessionId);
    client.state.on("capabilitiesChange", onCaps);

    return () => {
      client.state.off("sessionIdChange", onSessionId);
      client.state.off("capabilitiesChange", onCaps);
    };
  }, [client]);

  return {
    sessionId,
    capabilities,
    supportsImages: client.state.supportsImages,
    supportsSessionHistory: client.state.supportsSessionHistory,
  };
}
