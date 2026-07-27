import { AlertCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

type ExternalIframeServiceId = "label-studio" | "langfuse" | "llama-factory" | "apisix" | "ragflow";

interface ExternalIframePageProps {
  title?: string;
  titleKey?: string;
  subtitle: string;
  iframeUrl: string;
  preflightUrl?: string;
}

const EXTERNAL_IFRAME_CONTEXT_COOKIE = "fenix_external_iframe_service";

function getIframeServiceId(iframeUrl: string): ExternalIframeServiceId | null {
  if (iframeUrl.startsWith("/label-studio")) return "label-studio";
  if (iframeUrl.startsWith("/langfuse")) return "langfuse";
  if (iframeUrl.startsWith("/llama-factory")) return "llama-factory";
  if (iframeUrl.startsWith("/apisix")) return "apisix";
  if (iframeUrl.startsWith("/ragflow")) return "ragflow";
  return null;
}

function setActiveIframeService(serviceId: ExternalIframeServiceId): void {
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API browser support incomplete, fallback to document.cookie
  document.cookie = `${EXTERNAL_IFRAME_CONTEXT_COOKIE}=${encodeURIComponent(serviceId)}; Path=/; SameSite=Lax`;
}

export function ExternalIframePage({ title, titleKey, subtitle, iframeUrl, preflightUrl }: ExternalIframePageProps) {
  const { t } = useTranslation();
  const displayTitle = titleKey ? t(titleKey) : title || "External Service";
  const serviceId = useMemo(() => getIframeServiceId(iframeUrl), [iframeUrl]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [contextReady, setContextReady] = useState(!serviceId);
  const [preflightDone, setPreflightDone] = useState(!preflightUrl);

  const src = useMemo(
    () => `${iframeUrl}${iframeUrl.includes("?") ? "&" : "?"}_t=${reloadKey}`,
    [iframeUrl, reloadKey],
  );

  const handleLoad = useCallback(() => {
    setLoading(false);
    setFailed(false);
  }, []);

  const handleError = useCallback(() => {
    setLoading(false);
    setFailed(true);
  }, []);

  const handleReload = useCallback(() => {
    setLoading(true);
    setFailed(false);
    setPreflightDone(!preflightUrl);
    setReloadKey((value) => value + 1);
  }, [preflightUrl]);

  useEffect(() => {
    setContextReady(false);
    if (serviceId) {
      setActiveIframeService(serviceId);
    }
    setContextReady(true);
  }, [serviceId]);

  useEffect(() => {
    if (!preflightUrl) {
      setPreflightDone(true);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    setPreflightDone(false);

    fetch(preflightUrl, {
      method: "POST",
      credentials: "include",
      signal: controller.signal,
    })
      .catch((err) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          console.warn("[external-iframe] preflight failed, loading iframe with plain proxy", err);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setPreflightDone(true);
        }
      });

    return () => controller.abort();
  }, [preflightUrl]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#f4f7fb] text-[#14213d]">
      <div className="flex items-center justify-between border-b border-[#e8edf4] bg-white px-6 py-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-6 text-[#14213d]">{displayTitle}</h1>
          <p className="mt-1 text-sm text-[#667085]">{subtitle}</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleReload}>
          <RefreshCw className="mr-2 h-4 w-4" />
          刷新
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#f4f7fb]">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          </div>
        )}

        {failed && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#f4f7fb]">
            <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-[#e8edf4] bg-white p-6 text-center shadow-sm">
              <AlertCircle className="h-8 w-8 text-red-500" />
              <div>
                <div className="text-sm font-semibold text-[#14213d]">Service failed to load</div>
                <div className="mt-1 text-sm text-[#667085]">Check the upstream service or proxy configuration.</div>
              </div>
              <Button size="sm" onClick={handleReload}>
                Retry
              </Button>
            </div>
          </div>
        )}

        {contextReady && preflightDone && (
          <iframe
            key={reloadKey}
            title={displayTitle}
            src={src}
            className="h-full w-full border-0"
            onLoad={handleLoad}
            onError={handleError}
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        )}
      </div>
    </div>
  );
}
