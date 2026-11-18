import type { SyncCapacityProfile } from "../capacity/profile";
import { fidelitySerialize } from "../history/fidelity-json";
import { SyncProtocolError } from "../protocol/errors";
import type { SyncHistoryRecord } from "./host-session";

/** 源提交请求；检查点是应用适配器管理的不透明值。 */
export interface ProjectionRecordsInput {
  readonly sourceCheckpoint: string;
  readonly records: readonly SyncHistoryRecord[];
}
/** 记录按顺序提交后才能确认源检查点，失败保留原始异常及重试可能。 */
export function createHostProjectionIngress(input: {
  readonly capacity: SyncCapacityProfile;
  readonly accept: (record: SyncHistoryRecord) => Promise<void>;
}): { accept(request: ProjectionRecordsInput): Promise<{ sourceCheckpoint: string }> } {
  let queue: Promise<unknown> = Promise.resolve();
  let checkpoint: string | null = null;
  let pendingBytes = 0;
  let pendingRecords = 0;
  return {
    async accept(request) {
      if (!request.sourceCheckpoint || request.sourceCheckpoint.length > input.capacity.inputs.recordHeaderMaxBytes) {
        throw new SyncProtocolError("MALFORMED_FRAME", { message: "invalid projection checkpoint" });
      }
      if (checkpoint === request.sourceCheckpoint) return { sourceCheckpoint: checkpoint };
      const bytes = request.records.reduce((sum, record) => sum + fidelitySerialize(record.value).byteLength, 0);
      if (
        pendingRecords + request.records.length > input.capacity.inputs.maxRecordsPerDoc ||
        pendingBytes + bytes > input.capacity.concurrency.liveWaitPerScopeBytes
      ) {
        throw new SyncProtocolError("CAPACITY_EXCEEDED", { message: "projection ingress queue exceeds its budget" });
      }
      pendingBytes += bytes;
      pendingRecords += request.records.length;
      const run = queue.then(async () => {
        if (checkpoint !== request.sourceCheckpoint) {
          for (const record of request.records) await input.accept(record);
          checkpoint = request.sourceCheckpoint;
        }
        return { sourceCheckpoint: request.sourceCheckpoint };
      });
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      try {
        return await run;
      } finally {
        pendingBytes -= bytes;
        pendingRecords -= request.records.length;
      }
    },
  };
}
