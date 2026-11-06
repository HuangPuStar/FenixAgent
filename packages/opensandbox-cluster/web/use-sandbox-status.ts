import { useEffect, useState } from "react";
import { ClusterApiError, type ClusterClient } from "./api/client";
import type { Allocation } from "./api/types";
import { t } from "./i18n";

interface NativeStatus {
  state?: string;
  error?: string;
}
type Target = Pick<
  Allocation,
  "sandbox_id" | "allocation_etag" | "provider_sandbox_id" | "state" | "expires_at" | "proxy_url"
>;
function identity(item: Target) {
  return JSON.stringify([item.sandbox_id, item.allocation_etag, item.provider_sandbox_id]);
}

/** Poll visible native sandboxes with bounded concurrency; canceled reads never overwrite a newer page. */
export function useSandboxStatus(client: ClusterClient, items?: Allocation[], refreshVersion = 0) {
  const [statuses, setStatuses] = useState<Record<string, NativeStatus>>({});
  const source = JSON.stringify(
    (items ?? []).map(({ sandbox_id, allocation_etag, provider_sandbox_id, state, expires_at, proxy_url }) => ({
      sandbox_id,
      allocation_etag,
      provider_sandbox_id,
      state,
      expires_at,
      proxy_url,
    })),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshVersion 是用户操作后的显式刷新信号。
  useEffect(() => {
    const targets: Target[] = JSON.parse(source);
    const keys = new Set(targets.map(identity));
    setStatuses((previous) => {
      const kept = Object.entries(previous).filter(([key]) => keys.has(key));
      return kept.length === Object.keys(previous).length ? previous : Object.fromEntries(kept);
    });
    if (!targets.length) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        if (document.hidden) schedule();
        else void poll();
      }, 10000);
    };
    const poll = async () => {
      const queue = targets.filter(
        (item) =>
          item.provider_sandbox_id && item.state === "active" && (!item.expires_at || item.expires_at > Date.now()),
      );
      await Promise.all(
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          for (let item = queue.shift(); item && !controller.signal.aborted; item = queue.shift()) {
            let value: NativeStatus;
            try {
              const result = await client.request<{ status?: { state?: unknown } }>(
                `${item.proxy_url}/v1/sandboxes/${encodeURIComponent(item.provider_sandbox_id!)}`,
                { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) },
              );
              if (typeof result?.status?.state !== "string") throw new Error(t("节点未返回运行状态"));
              value = { state: result.status.state };
            } catch (error) {
              value =
                error instanceof ClusterApiError && error.status === 404
                  ? { state: t("已销毁") }
                  : { error: error instanceof Error ? error.message : t("状态查询失败") };
            }
            if (!controller.signal.aborted) {
              const key = identity(item);
              setStatuses((previous) => ({ ...previous, [key]: value.error ? { ...previous[key], ...value } : value }));
            }
          }
        }),
      );
      if (controller.signal.aborted) return;
      schedule();
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, source, refreshVersion]);
  return (item: Allocation): NativeStatus => {
    if (["released", "expired", "failed"].includes(item.state)) return { state: t("已销毁") };
    if (!item.provider_sandbox_id || item.state !== "active") return { state: t("待确认") };
    if (item.expires_at && item.expires_at <= Date.now()) return { state: t("待回收") };
    return statuses[identity(item)] ?? {};
  };
}
