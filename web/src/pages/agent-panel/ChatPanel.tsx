import { Bot, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ACPMain } from "@/components/ACPMain";
import { Button } from "@/components/ui/button";
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
  contextKey?: string;
  onPromptComplete?: () => void;
}

export function ChatPanel({
  agentId,
  sessionId,
  initialCwd,
  hideSidebar,
  onClientChange,
  scenePrompt,
  contextKey,
  onPromptComplete,
}: ChatPanelProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const [client, setClient] = useState<ACPClient | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<ACPClient | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const lastReconnectRef = useRef(0);

  // 监听实例重启事件，强制重连（带最小间隔防止风暴）
  useEffect(() => {
    const handler = (e: Event) => {
      const { envId } = (e as CustomEvent<{ envId: string }>).detail;
      if (envId === agentId) {
        const now = Date.now();
        const elapsed = now - lastReconnectRef.current;
        // Minimum 2s between reconnects
        if (elapsed < 2000) return;
        lastReconnectRef.current = now;
        setReconnectKey((k) => k + 1);
      }
    };
    window.addEventListener("agent:reconnect", handler);
    return () => window.removeEventListener("agent:reconnect", handler);
  }, [agentId]);

  // 使用 useLayoutEffect 在 paint 前同步重置状态，避免切换 agent / 重连时闪烁过时 UI
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnectKey 变更时需强制重建连接
  useLayoutEffect(() => {
    if (!agentId) {
      setClient(null);
      setConnectionState("disconnected");
      setError(null);
      onClientChange?.(null);
      return;
    }

    // 切换 agent 或手动重连时，立即进入 connecting，清空旧 error
    // 否则旧 error 会留在 state 中，导致渲染时短暂显示上一个 agent 的错误页面
    setConnectionState("connecting");
    setError(null);

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
      onClientChange?.(null);
    };
  }, [agentId, sessionId, onClientChange, reconnectKey]);

  // 手动重连：立即进入 connecting，再递增 reconnectKey 触发 useLayoutEffect 重建连接
  const handleManualReconnect = () => {
    const now = Date.now();
    const elapsed = now - lastReconnectRef.current;
    if (elapsed < 2000) return;
    lastReconnectRef.current = now;
    setError(null);
    setConnectionState("connecting");
    setReconnectKey((k) => k + 1);
  };

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

  // 错误状态：优先判断，client 可能仍存在（远程节点被动断开时 useLayoutEffect 未重新执行）
  // 此时不能进入 "已连接" 或 "连接中"，必须显示错误页面 + 重连按钮
  if (connectionState === "error") {
    const isMachineUnavailable = error === "machine_unavailable";
    const title = isMachineUnavailable ? t("machineUnavailable") : t("agentDisconnected");
    const desc = isMachineUnavailable ? t("machineUnavailableDesc") : error || t("agentOfflineDesc");
    return (
      <div className="agent-welcome-empty">
        <p className="title">{title}</p>
        <p className="desc">{desc}</p>
        {isMachineUnavailable && (
          <Button onClick={handleManualReconnect} variant="default" className="mt-4">
            <RefreshCw className="h-4 w-4" />
            {t("reconnect")}
          </Button>
        )}
      </div>
    );
  }

  // 连接中或 client 未初始化（包括切换 agent / 手动重连期间 client 被清空的过渡帧）
  if (connectionState === "connecting" || !client) {
    return (
      <div className="agent-welcome-empty">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
        <p className="title">{t("connectingAgent")}</p>
      </div>
    );
  }

  // 已连接 → 渲染 ACPMain
  if (connectionState === "connected") {
    return (
      <TooltipProvider>
        <ACPMain
          client={client}
          agentId={agentId}
          initialCwd={initialCwd}
          hideSidebar={hideSidebar}
          rcsSessionId={sessionId ?? undefined}
          scenePrompt={scenePrompt}
          contextKey={contextKey}
          onPromptComplete={onPromptComplete}
        />
      </TooltipProvider>
    );
  }

  // 断开（非错误，非连接中）
  return (
    <div className="agent-welcome-empty">
      <p className="title">{t("agentDisconnected")}</p>
      <p className="desc">{t("agentOfflineDesc")}</p>
    </div>
  );
}
