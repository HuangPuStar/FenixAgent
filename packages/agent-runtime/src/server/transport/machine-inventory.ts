/**
 * 同 server epoch 重连的实例清单对账。
 *
 * 机器只能证明「本进程里这些 runtime 仍存活」；归属与运行事实仍以主服务 Core runtime 为准。
 * 这里的判定是纯函数，删除动作留给调用方（见 `reconcileMachineInstances`），避免解析与宿主副作用混在一起。
 */

import { SERVER_EPOCH } from "@fenix/remote-runtime";
import { getBoundCoreRuntime } from "../services/core-runtime-port";

/** 机器上报的单条存活实例。 */
export interface MachineInventoryItem {
  instanceUid: string;
  runtimeGeneration: number;
  serverEpoch: string;
  sessionId: string | null;
  processAlive: boolean;
}

/** 被拒绝接管的实例及原因（机器据此停止并遗忘该 runtime）。 */
export interface RejectedMachineInventoryItem {
  instanceUid: string;
  reason: string;
}

export interface MachineInventoryDecision {
  accepted: Array<{ instance_uid: string; runtime_generation: number }>;
  rejected: RejectedMachineInventoryItem[];
}

/**
 * 解析 `register.instances`。结构不可信时返回 null，调用方按首次注册处理（clean-slate），
 * 不能把半截清单当成「没有实例」而误删服务端运行事实。
 */
export function parseMachineInventory(raw: unknown): MachineInventoryItem[] | null {
  if (!Array.isArray(raw)) return null;
  const items: MachineInventoryItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    const instanceUid = record.instance_uid;
    const runtimeGeneration = record.runtime_generation;
    const serverEpoch = record.server_epoch;
    if (typeof instanceUid !== "string" || instanceUid.length === 0) return null;
    if (typeof runtimeGeneration !== "number" || !Number.isSafeInteger(runtimeGeneration) || runtimeGeneration <= 0) {
      return null;
    }
    if (typeof serverEpoch !== "string") return null;
    items.push({
      instanceUid,
      runtimeGeneration,
      serverEpoch,
      sessionId: typeof record.session_id === "string" ? record.session_id : null,
      processAlive: record.process_alive === true,
    });
  }
  return items;
}

/** 按 Core runtime 当前映射核对机器清单；返回可保留与被拒绝的实例。 */
export function reconcileMachineInventory(
  machineId: string,
  items: readonly MachineInventoryItem[],
): MachineInventoryDecision {
  const runtime = getBoundCoreRuntime();
  const accepted: MachineInventoryDecision["accepted"] = [];
  const rejected: RejectedMachineInventoryItem[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (seen.has(item.instanceUid)) {
      rejected.push({ instanceUid: item.instanceUid, reason: "duplicate_instance" });
      continue;
    }
    seen.add(item.instanceUid);

    if (item.serverEpoch !== SERVER_EPOCH) {
      rejected.push({ instanceUid: item.instanceUid, reason: "epoch_mismatch" });
      continue;
    }
    if (!item.processAlive) {
      rejected.push({ instanceUid: item.instanceUid, reason: "process_not_alive" });
      continue;
    }

    const instance = runtime.getInstance(item.instanceUid);
    if (!instance) {
      rejected.push({ instanceUid: item.instanceUid, reason: "runtime_missing" });
      continue;
    }
    if (instance.nodeId !== machineId) {
      // 跨机器归属一律拒绝：新连接不能凭 instance uid 接管别的 Machine 的 runtime。
      rejected.push({ instanceUid: item.instanceUid, reason: "foreign_runtime" });
      continue;
    }
    if (instance.runtimeGeneration !== item.runtimeGeneration || instance.serverEpoch !== SERVER_EPOCH) {
      rejected.push({ instanceUid: item.instanceUid, reason: "runtime_fence_mismatch" });
      continue;
    }
    if (instance.status !== "running") {
      // 启动/停止中的结果未知，保留会制造无法确认归属的运行实体；交给机器严格收口。
      rejected.push({ instanceUid: item.instanceUid, reason: "runtime_not_running" });
      continue;
    }

    accepted.push({ instance_uid: item.instanceUid, runtime_generation: item.runtimeGeneration });
  }

  return { accepted, rejected };
}
