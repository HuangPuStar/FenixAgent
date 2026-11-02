/**
 * 回收站列表（只在切换到回收站视图时取数）。
 *
 * `ready` 变化会触发首次运行：页面初始停留在文件视图时这里不发请求，切过去才拉取。
 */

import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { cloudDriveApi } from "../api/cloud-drive";
import type { CloudDriveTrashEntry } from "../types/cloud-drive";

export function useCloudDriveTrash(enabled: boolean) {
  const request = useRequest(() => unwrap(cloudDriveApi.listTrash()), {
    ready: enabled,
    refreshDeps: [enabled],
    onError: (error) => console.error("Failed to load cloud drive trash", error),
  });

  return {
    entries: (request.data?.items ?? []) as CloudDriveTrashEntry[],
    loading: request.loading,
    error: request.error,
    refresh: request.refresh,
  };
}
