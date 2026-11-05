import { useEffect, useRef, useState } from "react";
import type { ClusterClient } from "./api/client";
import { t } from "./i18n";

/** Cancel obsolete reads when filters, authentication or the refresh version changes. */
export function useData<T>(client: ClusterClient, path: string, version = 0) {
  const [state, setState] = useState<{ data?: T; loading: boolean; error: string }>({ loading: true, error: "" });
  const [retry, setRetry] = useState(0);
  const source = useRef({ client, path });
  // biome-ignore lint/correctness/useExhaustiveDependencies: version 和 retry 是 URL 不变时的显式刷新信号。
  useEffect(() => {
    const abort = new AbortController();
    const sameSource = source.current.client === client && source.current.path === path;
    source.current = { client, path };
    setState((current) =>
      sameSource && current.data !== undefined
        ? { ...current, loading: false, error: "" }
        : { loading: true, error: "" },
    );
    client.request<T>(path, { signal: abort.signal }).then(
      (data) => {
        if (!abort.signal.aborted) setState({ data, loading: false, error: "" });
      },
      (error) => {
        if (!abort.signal.aborted)
          setState((current) => ({
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : t("请求失败"),
          }));
      },
    );
    return () => abort.abort();
  }, [client, path, version, retry]);
  return { ...state, retry: () => setRetry((value) => value + 1) };
}
