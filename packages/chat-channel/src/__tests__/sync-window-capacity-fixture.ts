import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import { MAX_FRAME_HEADER_BYTES } from "../sync/protocol/frames";

/** 窄窗口夹具同时缩小可提交快照，保证首次订阅完整 base 与持续更新都能发送。 */
export function windowCapacity(
  windowBytes: number,
  base: SyncCapacityProfile = DEFAULT_SYNC_CAPACITY,
): SyncCapacityProfile {
  const hardBytes = Math.floor((windowBytes - MAX_FRAME_HEADER_BYTES - 13) / 4) * 3;
  if (!Number.isSafeInteger(hardBytes) || hardBytes <= 0) throw new Error("fixture window cannot fit a data frame");
  return {
    ...base,
    concurrency: { ...base.concurrency, connectionBodyWindowBytes: windowBytes, socketHighWatermarkBytes: windowBytes },
    inputs: {
      ...base.inputs,
      historyBlockHardBytes: Math.min(base.inputs.historyBlockHardBytes, hardBytes),
      historyBlockTargetPayloadBytes: Math.min(base.inputs.historyBlockTargetPayloadBytes, hardBytes),
      activeHardEncodedBytes: Math.min(base.inputs.activeHardEncodedBytes, hardBytes),
      runtimeHardSnapshotBytes: Math.min(base.inputs.runtimeHardSnapshotBytes, hardBytes),
      directoryHardBytes: Math.min(base.inputs.directoryHardBytes, hardBytes),
      controlHardBytes: Math.min(base.inputs.controlHardBytes, hardBytes),
    },
  };
}
