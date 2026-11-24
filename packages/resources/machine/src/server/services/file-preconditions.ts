import { FileServiceError } from "./file-types";
import { computeReadFingerprint } from "./workspace-fs";

/** HTTP If-Match 单值弱比较：剥离 W/ 前缀与引号后按字符串相等判定（与读侧
 *  If-None-Match 的 etagMatches 同规约），保证"读到的 ETag 能原样写回比对"。 */
function etagEquals(ifMatch: string, etag: string): boolean {
  const normalize = (v: string) => v.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  return normalize(ifMatch) === normalize(etag);
}

/** If-Match 版本比对（§4.4）：当前版本（size+mtimeMs 派生 ETag，与读侧 read 指纹
 *  computeReadFingerprint 同源同规则）与消费者读取时携带的 ETag 不一致 → 409
 *  version_conflict + 当前版本回显（覆盖可感知性：消费者据此提示"文件已被修改"）。
 *  只保护"消费者-消费者"读改写——Agent 工具写入不走 HTTP、无 ETag，不参与比对
 *  （文档边界 §4.4）；mtime 缺失（远程弱指纹）时退化为 size-only 比对。 */
export function assertVersionMatch(
  ifMatch: string | undefined,
  displayPath: string,
  size: number,
  mtimeMs: number | undefined,
): void {
  if (ifMatch === undefined) return;
  // HTTP If-Match 通配 `*`：表示"资源必须存在"，当前 stat 已证明存在 → 放行
  if (ifMatch.trim() === "*") return;
  const currentEtag = computeReadFingerprint(size, mtimeMs);
  if (!etagEquals(ifMatch, currentEtag)) {
    throw new FileServiceError(`文件已被修改 (${displayPath})，请刷新后重试`, "version_conflict", 409, {
      etag: currentEtag,
      mtimeMs: mtimeMs ?? 0,
      size,
    });
  }
}
