// packages/chat-channel/src/sync/history/build-dispatch.ts
// 历史导入的块构建分派（规格 §5.7 的「按 sourceOrdinal 有限构建」）：分组、分块、在有界在飞窗口内提交。
//
// 三条不变式（回归测试见 `__tests__/sync-history-scale.test.ts`）：
// ① 生产者受消费者约束：窗口上界取池的 worker 数，窗口满时先等最早提交的任务结算再提交下一组。
//    同步无界提交会让标准历史突发（设计 §15.1 T02：20,000 对象 ≈ 700+ 块）瞬间撞满池队列并抛
//    `CAPACITY_EXCEEDED`；池的容量语义不变，压力只回传给生产者。
// ② 一组记录必须被块完全覆盖：构建器只返回装得进硬限的**前缀**，剩余记录由同一任务继续构建，直到整组
//    覆盖；续建失败说明目录必然覆盖不到接收边界，按 `IMPORT_INCOMPLETE` 上报并保留 `cause`（首块失败
//    仍按原错误码透传，例如单条记录超硬限的 `CAPACITY_EXCEEDED`）。
// ③ 失败先结清在飞任务再抛出：任何已提交任务都在窗口内被 await，调用方的清理（释放暂存段）才不会与
//    在飞读取重叠；首个失败是权威原因，其余失败由它派生，只结算不再上报。

import type { SyncSafeContext } from "../protocol/errors";
import { SyncProtocolError } from "../protocol/errors";
import type { CommitOutcome } from "../store/types";
import type { BlockRecordInput, BuiltBlock } from "./block-builder";
import type { BlockBuildPool } from "./build-pool";

/** 记录读取缝：只按 ordinal 取保真字节，实现方是暂存流（`HistoryIngest.readRecord`）。 */
export interface BlockRecordSource {
  readRecord(sourceOrdinal: number): Promise<Uint8Array>;
}

/** 分派依赖：构建一块、提交一块。块序号由分派器按构建顺序同步领取，保证同代次内唯一。 */
export interface BlockDispatchDeps {
  source: BlockRecordSource;
  /** 构建一块；`records` 是尚未成块的剩余记录（构建器自行按硬限截取前缀）。 */
  buildBlock(input: { blockIndex: number; records: readonly BlockRecordInput[] }): BuiltBlock;
  commitBlock(block: BuiltBlock): Promise<CommitOutcome>;
}

/** 一次分派：把记录组按顺序交给构建池。 */
export class BlockDispatcher {
  private readonly pool: BlockBuildPool;
  private readonly deps: BlockDispatchDeps;
  private readonly context: SyncSafeContext;
  /** 下一块的谱系槽位：按「块开始构建」的顺序递增，多块组与多组并发都不会撞号。 */
  private nextBlockIndex = 0;
  private committed = 0;

  constructor(pool: BlockBuildPool, deps: BlockDispatchDeps, context: SyncSafeContext = {}) {
    this.pool = pool;
    this.deps = deps;
    this.context = context;
  }

  /** 已提交块数（`already-committed` 幂等命中计入，与目录条目数口径一致）。 */
  committedBlocks(): number {
    return this.committed;
  }

  /** 在有界在飞窗口内提交全部记录组并等待结算；首个失败在在飞任务全部结清之后抛出。 */
  async dispatch(groups: readonly (readonly BlockRecordInput[])[]): Promise<void> {
    const window = Math.max(1, this.pool.workerCount());
    const inFlight: Promise<void>[] = [];
    let failure: unknown = null;
    for (const records of groups) {
      if (failure !== null) {
        break;
      }
      while (inFlight.length >= window) {
        await inFlight.shift();
      }
      inFlight.push(
        this.submitGroup(records).then(
          () => {},
          (error: unknown) => {
            if (failure === null) {
              failure = error;
            }
          },
        ),
      );
    }
    await Promise.all(inFlight);
    if (failure !== null) {
      throw failure;
    }
  }

  /** 一组的构建任务：组内可能因硬限拆成多块，每块各占一个谱系槽位。 */
  private submitGroup(records: readonly BlockRecordInput[]): Promise<void> {
    const estimateBytes = Math.max(
      1,
      records.reduce((sum, record) => sum + record.payload.byteLength, 0),
    );
    return this.pool.submitAwaitingCapacity({
      estimateBytes,
      run: async (): Promise<void> => {
        let offset = 0;
        while (offset < records.length) {
          const remaining = offset === 0 ? records : records.slice(offset);
          const materialized: BlockRecordInput[] = [];
          for (const record of remaining) {
            const payload = await this.deps.source.readRecord(record.sourceOrdinal);
            materialized.push({ ...record, payload });
          }
          const blockIndex = this.nextBlockIndex;
          this.nextBlockIndex += 1;
          const block = this.buildChunk(materialized, blockIndex, offset > 0);
          if (block.recordCount <= 0 || block.recordCount > remaining.length) {
            // 记录数不推进就会永远转下去；构建器违约必须显式失败，不能靠单调推进兜底。
            throw new SyncProtocolError("MALFORMED_FRAME", {
              message: "content block does not cover a positive prefix of its input records",
              safeContext: { ...this.context, docId: block.docId },
            });
          }
          offset += block.recordCount;
          const outcome = await this.deps.commitBlock(block);
          if (outcome === "committed" || outcome === "already-committed") {
            this.committed += 1;
          }
        }
      },
    });
  }

  /** 构建一块，并把「续建失败」归一到 `IMPORT_INCOMPLETE`（首块失败按原错误码透传）。 */
  private buildChunk(records: readonly BlockRecordInput[], blockIndex: number, isContinuation: boolean): BuiltBlock {
    try {
      return this.deps.buildBlock({ blockIndex, records });
    } catch (error) {
      if (!isContinuation) {
        throw error;
      }
      throw new SyncProtocolError("IMPORT_INCOMPLETE", {
        message: "block builder did not cover the whole record group",
        cause: error,
        safeContext: { ...this.context },
      });
    }
  }
}
