/**
 * 恢复核对的附件域判定：`attachment.upload`（T05）。
 *
 * 与另外三域的差别只有一条判据来源：附件**没有身份头**，也没有本地行可读，因此「这次上传落库了吗」只能
 * 靠远端集合上的**文件名 + 字节数**比对（`intent` 里正是这两个字段，加上内容摘要在本端留痕）。
 *
 * 归零与多义的口径与其它域逐字一致：
 * - 0 条匹配 → `unmatched`（不判失败：附件可能仍在存储队列里，方案 §9.6「不得凭暂时没有认定失败」）；
 * - 多条匹配 → `ambiguous`（同一工单上重复上传同名同大小的文件是正常操作，无法指认哪一条是本次的结果，
 *   交人工核对，绝不猜一个 ID 当作成功）；
 * - 恰好 1 条 → `applied`，且**没有** `apply`：附件没有索引行或归属行要补，成功终态就是账本自己。
 */

import type { TicketOperationRow } from "../repositories/ticket-operations";
import { TICKET_OPERATION_STEP } from "./ticket-operation-service";
import {
  intentNumber,
  intentString,
  type RecoveryRemote,
  type RecoveryVerdict,
  uniqueMatch,
} from "./ticket-recovery-shared";

/** `attachment.upload`：在工单的附件集合里按文件名与字节数唯一命中本次上传。 */
export async function inspectAttachmentUpload(
  row: TicketOperationRow,
  remote: RecoveryRemote,
): Promise<RecoveryVerdict> {
  const issueNumber = intentString(row, "issueNumber") ?? row.targetId;
  const name = intentString(row, "name");
  const size = intentNumber(row, "size");
  if (issueNumber === null || name === null || size === null) return { kind: "ambiguous" };

  // 一次读完整份集合（适配器按 `Link` 头翻完，有界）；附件没有分页游标，也无 `since` 窗口可缩小扫描面。
  const matched = uniqueMatch(
    (await remote.attachments.list(issueNumber)).filter((item) => item.name === name && item.size === size),
  );
  if (matched === "ambiguous" || matched === "unmatched") return { kind: matched };

  return {
    kind: "applied",
    step: TICKET_OPERATION_STEP.attachmentUploaded,
    targetId: matched.id,
    result: {
      attachmentId: matched.id,
      name: matched.name,
      size: matched.size,
      createdAt: matched.createdAt,
    },
    intentSummary: { name: matched.name, size: matched.size, issueNumber },
  };
}
