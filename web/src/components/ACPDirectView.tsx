import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ACPMain } from "../../components/ACPMain";
import { ACPClient, DisconnectRequestedError } from "../acp/client";
import type { ConnectionState } from "../acp/types";

interface ACPDirectViewProps {
  url: string;
  token: string;
  onBack: () => void;
}

export function ACPDirectView({ url, token, onBack }: ACPDirectViewProps) {
  const { t } = useTranslation("components");
  const [client, setClient] = useState<ACPClient | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<ACPClient | null>(null);

  useEffect(() => {
    const acpClient = new ACPClient({ proxyUrl: url, token });

    acpClient.setConnectionStateHandler((state, err) => {
      setConnectionState(state);
      setError(err || null);
    });

    acpClient.setAuthFailureHandler(() => {
      toast.error(t("acpDirect.loginExpired"));
      window.location.href = "/ctrl/login";
    });

    clientRef.current = acpClient;
    setClient(acpClient);

    acpClient.connect().catch((e) => {
      if (e instanceof DisconnectRequestedError) return;
      setError((e as Error).message);
      setConnectionState("error");
    });

    return () => {
      acpClient.disconnect();
      clientRef.current = null;
      setClient(null);
      setConnectionState("disconnected");
    };
  }, [url, token, t]);

  const showChat = client && connectionState === "connected";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Error bubble */}
      {error && connectionState === "error" && !client && (
        <div className="px-4 py-2 bg-status-error/10 text-status-error text-sm border-b">
          {error}
          <button onClick={onBack} className="ml-3 underline hover:no-underline">
            {t("acpDirect.backToDashboard")}
          </button>
        </div>
      )}

      {/* Initial connecting state */}
      {connectionState === "connecting" && !client && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="animate-spin h-8 w-8 border-2 border-brand border-t-transparent rounded-full mx-auto mb-3" />
            <p className="text-text-muted text-sm">{t("acpDirect.connectingAgent")}</p>
          </div>
        </div>
      )}

      {/* Error state (no client) */}
      {connectionState === "error" && !client && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="font-medium mb-1">{t("acpDirect.connectionFailed")}</p>
            <p className="text-text-muted text-sm mb-3">{error}</p>
            <button
              onClick={onBack}
              className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-light transition-colors"
            >
              {t("acpDirect.backToDashboard")}
            </button>
          </div>
        </div>
      )}

      {/* Chat view */}
      {showChat && <ACPMain client={client} />}
    </div>
  );
}
