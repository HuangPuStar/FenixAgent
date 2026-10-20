// packages/chat-channel/src/sync/live/content-tail.ts
// 恢复时确定实时写入入口：历史导入的内容块全部是已封口 canonical 块，不能接收增量。
//
// 选择顺序：目录页末位（实时轮换留下的 active successor）→ 代次入口闭包末位（空基线 active 块）→
// 新建 active 尾块。新建使用确定性 nonce，崩溃后重试命中同一 docId（`createDoc` 的
// `docId + hash` 幂等），不会为同一次恢复留下多份空块。
//
// 已知限制：若进程在「封口旧块」与「目录页追加 successor」之间崩溃，目录末位仍是已封口块且
// 存储没有读取 active Doc 的出口；此时恢复会写到封口块并由存储拒绝（显式失败，不伪造可写）。
// 移除条件：`ProjectionStore` 提供写入入口/active Doc 的读取能力。

import * as Y from "yjs";

import type { DigestFn } from "../clock";
import { SyncProtocolError } from "../protocol/errors";
import { buildDocId, parseDocId } from "../protocol/identity";
import type { ProjectionStore, SyncDocRecord, WriterLease } from "../store/types";
import type { DirectoryAppender } from "./directory-appender";

const CONTENT_KIND = "content";
/** 确定性 nonce：同一代次的恢复重试必须命中同一个 Doc，而不是每次新建一份空块。 */
const LIVE_TAIL_NONCE = "live-tail";

interface EnsureWritableContentDocInput {
  readonly store: ProjectionStore;
  readonly directory: DirectoryAppender;
  readonly scopeKey: string;
  readonly generation: string;
  /** 已冻结历史的终点；`0` 表示空基线（入口闭包末位本身就是 active 块）。 */
  readonly importEndOrdinal: number;
  /** 入口闭包末位内容块：历史导入完成后它是已封口块。 */
  readonly closureTailDocId: string;
  readonly lease: WriterLease;
  readonly digest: DigestFn;
}

/**
 * 返回可接收实时增量的内容块 ID；必要时先创建并登记到目录。
 *
 * 目录末位与入口闭包末位不同，说明此前已有实时轮换，直接复用轮换出的 active 块；两者相同且
 * 存在导入历史时，闭包末位是已封口块，必须新建 active 尾块并追加到目录，客户端才能发现它。
 */
export async function ensureWritableContentDoc(input: EnsureWritableContentDocInput): Promise<string> {
  const directoryTail = input.directory.tailContentDocId();
  const needsLiveTail =
    input.importEndOrdinal > 0 && (directoryTail === null || directoryTail === input.closureTailDocId);
  if (!needsLiveTail) return directoryTail ?? input.closureTailDocId;

  const blockIndex = parseDocId(input.closureTailDocId).blockIndex + 1;
  const docId = buildDocId({ kind: CONTENT_KIND, generation: input.generation, blockIndex, nonce: LIVE_TAIL_NONCE });
  const snapshot = Y.encodeStateAsUpdate(new Y.Doc());
  const doc: SyncDocRecord = {
    scopeKey: input.scopeKey,
    generation: input.generation,
    docId,
    kind: CONTENT_KIND,
    state: "active",
    snapshot,
    hash: input.digest(snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex,
    // 实时块的 ordinal 范围由实时记录自身表达，不进入历史目录的已封口块序列。
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  };
  const settled = await input.store.createDoc({ scopeKey: input.scopeKey, epoch: input.lease.epoch, doc });
  if (settled.outcome === "conflict") {
    throw new SyncProtocolError("DIGEST_CONFLICT", {
      message: "live tail document holds different bytes",
      safeContext: { generation: input.generation, docId },
    });
  }
  if (settled.outcome === "unknown") {
    throw new SyncProtocolError("COMMIT_OUTCOME_UNKNOWN", {
      message: "live tail document registration is unknown",
      safeContext: { generation: input.generation, docId },
    });
  }
  await input.directory.appendContentDoc(input.lease, docId);
  return docId;
}
