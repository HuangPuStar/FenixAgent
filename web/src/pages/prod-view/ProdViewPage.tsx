import { useParams } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChatInterface } from "@/components/ChatInterface";
import { ProdViewShell } from "@/components/prod-view/ProdViewShell";
import { Button } from "@/components/ui/button";
import type { ACPClient } from "@/src/acp/client";
import { DisconnectRequestedError } from "@/src/acp/client";
import { createRelayClient } from "@/src/acp/relay-client";
import { prodViewApi } from "@/src/api/prod-views";
import { unwrap } from "@/src/api/request";
import { NS } from "@/src/i18n";

export function ProdViewPage() {
  const { prodViewId } = useParams({ from: "/view/$prodViewId" }) as { prodViewId: string };
  const { t } = useTranslation(NS.PROD_VIEWS);

  const [client, setClient] = useState<ACPClient | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const [retryKey, setRetryKey] = useState(0);

  // 加载视图配置
  const { data: viewConfig, loading, error: loadError } = useRequest(async () => unwrap(prodViewApi.load(prodViewId)));

  // 配置加载后建立 relay 连接
  const connectRelay = useCallback((agentId: string) => {
    mountedRef.current = true;
    const relayClient = createRelayClient(agentId);
    relayClient.setConnectionStateHandler((state) => {
      if (state === "error" && mountedRef.current) {
        setConnectionError("Connection failed");
      }
    });

    relayClient.connect().catch((e: unknown) => {
      if (e instanceof DisconnectRequestedError) return;
      if (mountedRef.current) setConnectionError((e as Error).message);
    });

    setClient(relayClient);

    return () => {
      mountedRef.current = false;
      relayClient.disconnect();
      setClient(null);
    };
  }, []);

  useEffect(() => {
    if (!viewConfig) return;
    // retryKey 变化时清空错误状态并强制重新建立 relay 连接
    if (retryKey > 0) setConnectionError(null);
    const cleanup = connectRelay(viewConfig.agentId);
    return cleanup;
  }, [viewConfig, connectRelay, retryKey]);

  if (loading) {
    return (
      <ProdViewShell>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      </ProdViewShell>
    );
  }

  if (loadError || connectionError) {
    return (
      <ProdViewShell>
        <div className="flex h-full flex-col items-center justify-center gap-4">
          <p className="text-gray-500">{connectionError ?? (loadError as Error)?.message ?? t("loadError")}</p>
          <Button variant="outline" onClick={() => setRetryKey((k) => k + 1)}>
            {t("retry")}
          </Button>
        </div>
      </ProdViewShell>
    );
  }

  if (!viewConfig || !client) return null;

  return (
    <ProdViewShell title={viewConfig.name}>
      <ChatInterface client={client} agentId={viewConfig.agentId} modulesConfig={viewConfig.modulesConfig} />
    </ProdViewShell>
  );
}
