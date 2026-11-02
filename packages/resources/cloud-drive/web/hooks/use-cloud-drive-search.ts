/**
 * 关键词搜索（`POST /web/cloud-drive/search`）。
 *
 * 手动触发而非输入即搜：搜索是最终一致的远端调用，逐字符请求既浪费又会让结果顺序抖动；
 * 页面在用户提交表单或点击按钮时才调用 `run`。
 */

import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { cloudDriveApi } from "../api/cloud-drive";

/** 每页文件数；服务端上限 50，20 个文件足够紧凑列表一屏扫完。 */
const SEARCH_LIMIT = 20;

export function useCloudDriveSearch() {
  // 结果带上查询词：手动 `run` 不取消上一个在途请求，慢响应回来时页面据此丢弃过期结果。
  const request = useRequest(
    async (query: string) => ({
      query,
      page: await unwrap(cloudDriveApi.search({ query, limit: SEARCH_LIMIT })),
    }),
    {
      manual: true,
      onError: (error) => console.error("Failed to search cloud drive", error),
    },
  );

  return {
    results: request.data?.page,
    resultQuery: request.data?.query,
    loading: request.loading,
    error: request.error,
    run: request.run,
    reset: request.cancel,
  };
}
