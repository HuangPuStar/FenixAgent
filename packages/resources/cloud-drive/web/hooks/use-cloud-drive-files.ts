/**
 * 目录列表的取数与游标分页。
 *
 * 第一页交给 `useRequest`（与仓库其它列表页一致：loading / error / refresh 语义现成）；
 * 后续页由 `loadMore` 追加，`refresh()` 会重置分页——这与「刷新当前目录」的直觉一致。
 */

import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cloudDriveApi } from "../api/cloud-drive";
import { CLOUD_DRIVE_NS } from "../i18n/namespace";
import { cloudDriveErrorMessage } from "../lib/errors";
import type { CloudDriveFile } from "../types/cloud-drive";

export function useCloudDriveFiles(parentId: string | null) {
  const { t } = useTranslation(CLOUD_DRIVE_NS);
  // 结果带上请求时的 parentId：`refreshDeps` 变化时 ahooks 会保留上一份 data，
  // 不加这层标记就会在切目录的首帧把父目录的条目当成当前目录的内容渲染出来。
  const page = useRequest(
    async () => {
      const result = await unwrap(cloudDriveApi.listFiles(parentId ? { parentId } : {}));
      return { parentId, result };
    },
    {
      refreshDeps: [parentId],
      onError: (error) => console.error("Failed to load cloud drive files", error),
    },
  );
  const currentPage = page.data?.parentId === parentId ? page.data.result : undefined;

  const [additional, setAdditional] = useState<CloudDriveFile[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  // 切换目录时先清掉上一页的追加结果，避免新目录短暂混入旧条目。
  // biome-ignore lint/correctness/useExhaustiveDependencies: parentId 变化即重置，属有意触发。
  useEffect(() => {
    setAdditional([]);
    setCursor(null);
    setLoadMoreError(null);
  }, [parentId]);

  // 第一页数据变化（首次加载或 refresh）时重置分页：refresh 后继续保留旧追加页会产生重复条目。
  useEffect(() => {
    setAdditional([]);
    setCursor(currentPage?.nextCursor ?? null);
  }, [currentPage]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const next = await unwrap(cloudDriveApi.listFiles({ ...(parentId ? { parentId } : {}), cursor }));
      setAdditional((previous) => [...previous, ...next.items]);
      setCursor(next.nextCursor);
    } catch (error) {
      console.error("Failed to load more cloud drive files", error);
      setLoadMoreError(cloudDriveErrorMessage(error, (key) => String(t(key))));
    } finally {
      setLoadingMore(false);
    }
  };

  return {
    items: [...(currentPage?.items ?? []), ...additional],
    loading: page.loading,
    error: page.error,
    refresh: page.refresh,
    loadMore,
    loadingMore,
    hasMore: cursor !== null,
    loadMoreError,
  };
}
