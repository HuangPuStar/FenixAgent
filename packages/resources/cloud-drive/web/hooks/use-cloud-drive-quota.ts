/**
 * 配额与主体（`/me`）。
 *
 * 配额失败不阻塞文件浏览：页面把「配额不可用」渲染成一行灰字，重试入口与文件列表共用刷新按钮。
 */

import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { cloudDriveApi } from "../api/cloud-drive";
import type { CloudDrivePrincipal } from "../types/cloud-drive";

export function useCloudDriveQuota() {
  const request = useRequest(() => unwrap(cloudDriveApi.me()), {
    onError: (error) => console.error("Failed to load cloud drive quota", error),
  });

  return {
    principal: request.data as CloudDrivePrincipal | undefined,
    loading: request.loading,
    error: request.error,
    refresh: request.refresh,
  };
}
