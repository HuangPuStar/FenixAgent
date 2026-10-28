import type { CloudDriveGateway } from "../client/cloud-drive-gateway";
import type { AggregatedSearchFile } from "./search-result";

/**
 * 搜索结果的元数据补齐。
 *
 * CloudDrive 的 `/v1/search` 只返回 `file_id` 与 `path`，没有名称、父目录、大小和更新时间。为了满足
 * 「一条结果包含文件元数据」的展示需要，这里按文件补一次 `GET /v1/files/:id`：
 *
 * - **并发受限**：最多 6 个在途请求，避免一次搜索把上游打满；
 * - **总时限**：2 秒后中止剩余请求，已完成的元数据照常返回；
 * - **软失败**：单个文件读取失败（典型是索引与数据库的最终一致窗口内文件已被删除）只回退到
 *   `path` 派生的名称，不让整个搜索失败，也不逐条记录日志。
 *
 * 这是展示性数据，不是搜索正确性的一部分；调用方永远拿得到聚合片段。
 */

const METADATA_CONCURRENCY = 6;
const METADATA_DEADLINE_MS = 2_000;

export async function enrichSearchFileMetadata(
  gateway: CloudDriveGateway,
  subject: string,
  files: readonly AggregatedSearchFile[],
  signal?: AbortSignal,
): Promise<AggregatedSearchFile[]> {
  if (files.length === 0) return [];

  const deadline = AbortSignal.timeout(METADATA_DEADLINE_MS);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const metadata = new Map<
    string,
    { name: string; parentId: string | null; sizeBytes: number | null; updatedAt: string | null }
  >();
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < files.length && !combined.aborted) {
      const file = files[nextIndex];
      nextIndex += 1;
      if (!file) return;
      try {
        const info = await gateway.getFile(subject, file.fileId, combined);
        metadata.set(file.fileId, {
          name: info.name,
          parentId: info.parentId,
          sizeBytes: info.sizeBytes,
          updatedAt: info.updatedAt,
        });
      } catch {
        // 展示性元数据失败不阻断搜索；片段本身仍然有效。
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(METADATA_CONCURRENCY, files.length) }, worker));

  return files.map((file) => {
    const info = metadata.get(file.fileId);
    if (!info) return file;
    return {
      ...file,
      name: info.name || file.name,
      parentId: info.parentId,
      sizeBytes: info.sizeBytes,
      updatedAt: info.updatedAt,
    };
  });
}
