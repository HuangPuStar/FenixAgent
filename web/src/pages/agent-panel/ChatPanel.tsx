import { Bot, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ACPMain } from "../../../components/ACPMain";
import { TooltipProvider } from "../../../components/ui/tooltip";
import { ACPClient, DisconnectRequestedError } from "../../acp/client";
import { createRelayClient } from "../../acp/relay-client";
import type { ConnectionState } from "../../acp/types";

interface ChatPanelProps {
  agentId: string | null;
  sessionId?: string | null;
  initialCwd?: string;
  hideSidebar?: boolean;
  onClientChange?: (client: ACPClient | null) => void;
  scenePrompt?: string;
}

export function ChatPanel({
  agentId,
  sessionId,
  initialCwd,
  hideSidebar,
  onClientChange,
  scenePrompt,
}: ChatPanelProps) {
  const [client, setClient] = useState<ACPClient | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<ACPClient | null>(null);

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
  }, [agentId]);

  // 未选中实例 → 欢迎空状态
  if (!agentId) {
    return (
      <div className="agent-welcome-empty">
        <Bot className="h-16 w-16" />
        <p className="title">选择一个智能体实例</p>
        <p className="desc">从左侧边栏选择一个智能体实例开始对话</p>
      </div>
    );
  }

  // 连接中
  if (connectionState === "connecting" && !client) {
    return (
      <div className="agent-welcome-empty">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
        <p className="title">正在连接 Agent...</p>
      </div>
    );
  }

  // 错误 / 断连
  if ((connectionState === "error" || connectionState === "disconnected") && !client) {
    return (
      <div className="agent-welcome-empty">
        <p className="title">Agent 未连接</p>
        <p className="desc">{error || "Agent 尚未上线，请确保 acp-link 已启动"}</p>
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
        />
      </TooltipProvider>
    );
  }

  // 回退：连接中
  return (
    <div className="agent-welcome-empty">
      <Loader2 className="h-8 w-8 animate-spin text-brand" />
      <p className="title">正在连接...</p>
    </div>
  );
}
