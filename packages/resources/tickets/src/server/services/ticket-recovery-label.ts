/**
 * 恢复核对的标签域判定：`label.create` / `label.update`（backend contract §8.3）。
 *
 * 标签的事实源在托管平台，本端**没有**本地行：核对命中即视为完成，`apply` 缺席（与工单/评论两域的
 * 「补齐索引或归属」不同）。
 *
 * 两个 kind 的判据差异：
 * - `create`：同名（`intent` 指定颜色时并要求颜色一致）的标签视为已创建；找不到就是 `unmatched`
 *   （同名语义弱，不判定「未落库」）。
 * - `update`：`targetId` 那一条的字段全部命中 `intent` → 已写；等于 `intent.before` → 确定未落库；
 *   两者都不是 → 不判定（交人工窗口）。
 */

import type { GitLabel } from "@fenix/git/server";
import type { TicketOperationRow } from "../repositories/ticket-operations";
import { TICKET_OPERATION_STEP } from "./ticket-operation-service";
import {
  intentOf,
  intentString,
  isRecord,
  type RecoveryRemote,
  type RecoveryVerdict,
  readOrNull,
  uniqueMatch,
} from "./ticket-recovery-shared";

/** 按 kind 分派标签口径（两者一起走 `labels.list()`，仓库标签集合是一次读就够的小集合）。 */
export async function inspectLabel(row: TicketOperationRow, remote: RecoveryRemote): Promise<RecoveryVerdict> {
  if (row.kind === "label.create") {
    const name = intentString(row, "name");
    if (name === null) return { kind: "unmatched" };
    const color = intentString(row, "color");
    const labels = await readOrNull(() => remote.labels.list());
    const matched =
      labels === null
        ? "unmatched"
        : uniqueMatch(labels.filter((label) => label.name === name && sameColor(label.color, color)));
    if (matched === "ambiguous" || matched === "unmatched") return { kind: matched };
    return appliedLabel(matched);
  }

  const labelId = row.targetId;
  if (labelId === null) return { kind: "unmatched" };
  const labels = await readOrNull(() => remote.labels.list());
  const label = labels?.find((item) => item.id === labelId);
  if (label === undefined) return { kind: "unmatched" };
  if (matchesLabelFields(label, pickLabelFields(intentOf(row)))) return appliedLabel(label);
  const before = intentOf(row).before;
  if (isRecord(before) && matchesLabelFields(label, pickLabelFields(before))) return { kind: "not_applied" };
  return { kind: "unmatched" };
}

/** 标签类没有本地写：命中即终态，`result` 用回源值拼出前端要的视图。 */
function appliedLabel(label: GitLabel): RecoveryVerdict {
  return {
    kind: "applied",
    step: TICKET_OPERATION_STEP.upstreamApplied,
    targetId: label.id,
    result: { labelId: label.id, name: label.name, color: label.color, description: label.description },
    intentSummary: { name: label.name, color: label.color },
  };
}

/** 标签字段投影：`intent` 目标与 `intent.before` 同形状，缺席/非字符串的项一律为 `null`（不参与判定）。 */
function pickLabelFields(value: Record<string, unknown>): LabelFields {
  return {
    name: typeof value.name === "string" ? value.name : null,
    color: typeof value.color === "string" ? value.color : null,
    description: typeof value.description === "string" ? value.description : null,
  };
}

interface LabelFields {
  readonly name: string | null;
  readonly color: string | null;
  readonly description: string | null;
}

function matchesLabelFields(
  label: { readonly name: string; readonly color: string | null; readonly description: string | null },
  wants: LabelFields,
): boolean {
  if (wants.name === null && wants.color === null && wants.description === null) return false;
  if (wants.name !== null && label.name !== wants.name) return false;
  if (wants.color !== null && !sameColor(label.color, wants.color)) return false;
  if (wants.description !== null && label.description !== wants.description) return false;
  return true;
}

/** 颜色比较：容忍 `#` 前缀与大小写（协议层已归一，远端回显可能带前缀）。 */
function sameColor(left: string | null, right: string | null): boolean {
  const normalize = (value: string | null) => (value === null ? null : value.replace(/^#/, "").toLowerCase());
  return normalize(left) === normalize(right);
}
