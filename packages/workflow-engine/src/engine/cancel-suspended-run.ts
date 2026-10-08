import { nanoid } from "nanoid";
import type { StorageAdapter } from "../storage/storage-adapter";
import type { DAGEvent, DAGSnapshot } from "../types/execution";

/** 挂起运行没有活跃调度器，取消时由引擎写入终态事件与快照。 */
export async function cancelSuspendedRun(runId: string, storage: StorageAdapter): Promise<boolean> {
  const snapshot = await storage.getLatestSnapshot(runId);
  if (snapshot?.dag_status === "CANCELLED") return true;
  if (snapshot?.dag_status !== "SUSPENDED") return false;

  const event: DAGEvent = {
    event_id: `evt_${nanoid(10)}`,
    run_id: runId,
    timestamp: new Date().toISOString(),
    type: "dag.cancelled",
  };
  const nodeStates: DAGSnapshot["node_states"] = Object.fromEntries(
    Object.entries(snapshot.node_states).map(([nodeId, state]) => [
      nodeId,
      state.status === "SUSPENDED" ? { ...state, status: "CANCELLED" as const } : state,
    ]),
  );
  await storage.atomicRunCancel({
    snapshot: {
      ...snapshot,
      snapshot_id: `snap_${nanoid(10)}`,
      last_event_id: event.event_id,
      timestamp: new Date().toISOString(),
      node_states: nodeStates,
      dag_status: "CANCELLED",
    },
    event,
  });
  return true;
}
