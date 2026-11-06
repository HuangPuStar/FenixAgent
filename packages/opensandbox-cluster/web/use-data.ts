import { useEffect, useRef, useState } from "react";
import type { ClusterClient } from "./api/client";
import { t } from "./i18n";

/** Cancel obsolete sources while allowing slow reads to finish across polling ticks. */
export function useData<T>(client: ClusterClient, path: string, version = 0) {
  const [state, setState] = useState<{ data?: T; loading: boolean; error: string }>({ loading: true, error: "" });
  const [retry, setRetry] = useState(0);
  const source = useRef({ client, path });
  const pending = useRef<AbortController | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅数据源切换或卸载时取消，轮询刷新必须保留在途读取。
  useEffect(() => {
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [client, path]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version 和 retry 是 URL 不变时的显式刷新信号。
  useEffect(() => {
    if (pending.current) return;
    const abort = new AbortController();
    pending.current = abort;
    const sameSource = source.current.client === client && source.current.path === path;
    source.current = { client, path };
    setState((current) =>
      sameSource && current.data !== undefined
        ? { ...current, loading: false, error: "" }
        : { loading: true, error: "" },
    );
    client.request<T>(path, { signal: abort.signal }).then(
      (data) => {
        if (!abort.signal.aborted) {
          pending.current = null;
          setState({ data, loading: false, error: "" });
        }
      },
      (error) => {
        if (!abort.signal.aborted) {
          pending.current = null;
          setState((current) => ({
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : t("请求失败"),
          }));
        }
      },
    );
  }, [client, path, version, retry]);
  return { ...state, retry: () => setRetry((value) => value + 1) };
}
