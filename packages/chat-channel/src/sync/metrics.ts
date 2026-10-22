import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("@fenix/chat-channel");

/** 秒级同步耗时：覆盖亚秒 ACK/快照与分钟级恢复。 */
export const SYNC_SECONDS_HISTOGRAM_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 0.9, 2.5, 5, 10, 30, 60, 300, 600, 1800, 3600,
];
/** 快照编码字节：10KiB、1MiB 与 256MiB 边界必须可直接查询。 */
export const SNAPSHOT_BYTES_HISTOGRAM_BUCKETS = [
  1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864, 268435456,
];
const seconds = { advice: { explicitBucketBoundaries: SYNC_SECONDS_HISTOGRAM_BUCKETS } };
export const syncAckDuration = meter.createHistogram("fenix.sync.ack.duration", { unit: "s", ...seconds });
export const syncFailures = meter.createCounter("fenix.sync.failures");
export const syncDisconnects = meter.createCounter("fenix.sync.disconnects");
export const historyRestoreDuration = meter.createHistogram("fenix.history.restore.duration", {
  unit: "s",
  ...seconds,
});
export const snapshotPersistDuration = meter.createHistogram("fenix.snapshot.persist.duration", {
  unit: "s",
  ...seconds,
});
export const snapshotSize = meter.createHistogram("fenix.snapshot.size", {
  unit: "By",
  advice: { explicitBucketBoundaries: SNAPSHOT_BYTES_HISTOGRAM_BUCKETS },
});

/** 仅保存活跃传输的只读诊断入口，解除注册后不持有 scope 或历史数据。 */
export function registerSyncDiagnostics(
  read: () => { connected: boolean; outstandingBytes: number; pendingTasks: number; unackedDeliveries: number },
): () => void {
  readers.add(read);
  return () => {
    readers.delete(read);
  };
}

const readers = new Set<
  () => { connected: boolean; outstandingBytes: number; pendingTasks: number; unackedDeliveries: number }
>();
const connections = meter.createObservableGauge("fenix.sync.connections", { unit: "{connection}" });
const tasks = meter.createObservableGauge("fenix.sync.queue.tasks", { unit: "{task}" });
const bytes = meter.createObservableGauge("fenix.sync.outstanding.bytes", { unit: "By" });
const unacked = meter.createObservableGauge("fenix.sync.unacked.deliveries", { unit: "{delivery}" });
meter.addBatchObservableCallback(
  (result) => {
    let connected = 0;
    let pendingTasks = 0;
    let outstandingBytes = 0;
    let unackedDeliveries = 0;
    for (const read of readers) {
      const state = read();
      if (state.connected) connected++;
      pendingTasks += state.pendingTasks;
      outstandingBytes += state.outstandingBytes;
      unackedDeliveries += state.unackedDeliveries;
    }
    const attrs = { channel: "sync" };
    result.observe(connections, connected, { ...attrs, state: "connected" });
    result.observe(tasks, pendingTasks, { ...attrs, queue: "transport" });
    result.observe(bytes, outstandingBytes, attrs);
    result.observe(unacked, unackedDeliveries, attrs);
  },
  [connections, tasks, bytes, unacked],
);
