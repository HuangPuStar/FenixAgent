import { Bot, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ACPMain } from "@/components/ACPMain";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type ACPClient, DisconnectRequestedError } from "../../acp/client";
import { createRelayClient } from "../../acp/relay-client";
import type { ConnectionState } from "../../acp/types";
import { NS } from "../../i18n";

interface ChatPanelProps {
  agentId: string | null;
  sessionId?: string | null;
  initialCwd?: string;
  hideSidebar?: boolean;
  onClientChange?: (client: ACPClient | null) => void;
  scenePrompt?: string;
  onPromptComplete?: () => void;
}

export function ChatPanel({
  agentId,
  sessionId,
  initialCwd,
  hideSidebar,
  onClientChange,
  scenePrompt,
  onPromptComplete,
}: ChatPanelProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const [client, setClient] = useState<ACPClient | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<ACPClient | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);

  // 监听实例重启事件，强制重连
  useEffect(() => {
    const handler = (e: Event) => {
      const { envId } = (e as CustomEvent<{ envId: string }>).detail;
      if (envId === agentId) {
        setReconnectKey((k) => k + 1);
      }
    };
    window.addEventListener("agent:reconnect", handler);
    return () => window.removeEventListener("agent:reconnect", handler);
  }, [agentId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectKey 变更时需强制重建连接
  useEffect(() => {
    if (!agentId) {
      setClient(null);
      setConnectionState("disconnected");
      setError(null);
      onClientChange?.(null);
      return;
    }

    const relayClient = createRelayClient(agentId, sessionId ?? undefined);

    relayClient.setConnectionStateHandler((state, err) => {
      setConnectionState(state);
      setError(err || null);
    });

    relayClient.connect().catch((e: unknown) => {
      if (e instanceof DisconnectRequestedError) return;
      setError((e as Error).message);
      setConnectionState("error");
    });

    clientRef.current = relayClient;
    setClient(relayClient);
    onClientChange?.(relayClient);

    return () => {
      relayClient.disconnect();
      clientRef.current = null;
      setClient(null);
      setConnectionState("disconnected");
      onClientChange?.(null);
    };
  }, [agentId, sessionId, onClientChange, reconnectKey]);

  // 未选中实例 → 欢迎空状态
  if (!agentId) {
    return (
      <div className="agent-welcome-empty">
        <Bot className="h-16 w-16" />
        <p className="title">{t("selectAgent")}</p>
        <p className="desc">{t("selectAgentDesc")}</p>
      </div>
    );
  }

  // 连接中
  if (connectionState === "connecting" && !client) {
    return (
      <div className="agent-welcome-empty">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
        <p className="title">{t("connectingAgent")}</p>
      </div>
    );
  }

  // 错误 / 断连
  if ((connectionState === "error" || connectionState === "disconnected") && !client) {
    return (
      <div className="agent-welcome-empty">
        <p className="title">{t("agentDisconnected")}</p>
        <p className="desc">{error || t("agentOfflineDesc")}</p>
      </div>
    );
  }

  // 已连接 → 渲染 ACPMain
  if (client && connectionState === "connected") {
    return (
      <TooltipProvider>
        <ACPMain
          client={client}
          agentId={agentId}
          initialCwd={initialCwd}
          hideSidebar={hideSidebar}
          rcsSessionId={sessionId ?? undefined}
          scenePrompt={scenePrompt}
          onPromptComplete={onPromptComplete}
        />
      </TooltipProvider>
    );
  }

  // 回退：连接中
  return (
    <div className="agent-welcome-empty">
      <Loader2 className="h-8 w-8 animate-spin text-brand" />
      <p className="title">{t("connecting")}</p>
    </div>
  );
}
