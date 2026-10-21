/**
 * 机器维度的实例收敛：删除该机器在 Core runtime 上的全部实例，并同步收敛实例登记表与编排域活跃表。
 *
 * 为什么归本包：实例登记表（`globalInstanceRegistry`）与编排域活跃表都是 Agent Runtime 的进程内状态，
 * 「从 Core runtime 删除实例时必须配对注销登记表」这条不变量只有登记表的 owner 能保证——漏配对的后果是
 * 该实例永久计入环境并发额度、`hasActiveInstance` 误判为存活，实例再也回收不掉。Core runtime 单例仍归
 * 宿主（`CoreRuntimePort`），本模块经它取实例列表与删除，不自行构造第二套 runtime。
 *
 * 调用方：宿主 `services/core-bootstrap` 的机器重连 / 断连 / 沙盒释放路径（`registerRemoteNode` 重连分支
 * 与 `unregisterRemoteNode`）。这三条路径都不经过 ACP handler 的实例回收链路（沙盒销毁尤其如此：它从
 * Sandbox → Machine 的释放路径直接走到节点注销），因此必须在这里一次性收敛，否则残留的幽灵实例会永久占用
 * 并发额度并阻塞空闲回收（E-P0.1）。
 */

import { log } from "@fenix/logger";
import { SERVER_EPOCH } from "@fenix/remote-runtime";
import { WEBSOCKET_CODES } from "acp-link/websocket-code";
import { agentInstanceRuntimeCoordinator, agentInstanceService } from "../server/services/agent-instance-service";
import { getBoundCoreRuntime } from "../server/services/core-runtime-port";
import { tryGetRelayLifecyclePort } from "../server/transport/relay/lifecycle-port";
import { globalInstanceRegistry } from "./instance-registry";
import { removeOrchestrationInstancesForMachine } from "./orchestration-machine-cleanup";

/**
 * 删除指定机器在 Core runtime 上的实例，并收敛其登记表与编排域状态（`AgentRuntimePort.cleanupMachineInstances`
 * 的实现）。
 *
 * 只处理「该机器当前仍有 core 实例」的情形；core 实例已消失但活跃表/登记表残留条目的情形由编排域收敛
 * （`cleanupOrchestrationInstancesForMachine`，本函数无条件调用）负责，两者互补、都幂等。
 *
 * @param machineId 目标机器 ID（内部标识，非用户输入）
 * @param options.runtimeTerminated 机器上的 runtime 已被平台确定终止（销毁 Provider 沙盒、机器退役），
 *   而不是暂时断连。此时持久实例的运行态条目一并复位为 `stopped`；断连路径不得设置，否则会把
 *   「可能仍在运行的远端进程」误判为可重新启动。
 * @returns 实际从 Core runtime 删除的实例数
 */
export function convergeMachineInstances(machineId: string, options: { runtimeTerminated?: boolean } = {}): number {
  const runtime = getBoundCoreRuntime();
  const removedInstanceIds: string[] = [];
  let removed = 0;

  for (const instance of runtime.listInstances()) {
    if (instance.nodeId !== machineId) continue;
    if (instance.runtimeGeneration !== undefined && instance.serverEpoch === SERVER_EPOCH) {
      agentInstanceRuntimeCoordinator.handleRuntimeDisconnect(
        instance.instanceId,
        instance.runtimeGeneration,
        machineId,
      );
    }
    runtime.deleteInstance(instance.instanceId);
    globalInstanceRegistry.unregisterAndDeleteCounter(instance.instanceId);
    removedInstanceIds.push(instance.instanceId);
    removed += 1;
    log(`[machine-instance-cleanup] Deleted instance ${instance.instanceId} on machine ${machineId}`);
  }

  const orchestrationInstanceIds = removeOrchestrationInstancesForMachine(machineId);

  if (options.runtimeTerminated) {
    const instanceUids = [...removedInstanceIds, ...orchestrationInstanceIds];
    // 沙盒 Provider 资源已被销毁、机器退役：旧进程不可能回连，运行态条目必须直接复位为
    // stopped。否则残留的 running/unknown 会挡住下一次 enter/restart，沙盒永远不按新配置重建。
    agentInstanceService.handleRuntimeTerminated({ machineId, instanceUids });
    // 释放先于断连事件到达时，ACP handler 的清理收集不到实例 ID，前端 relay 连接会挂在已死
    // 的 runtime 上；按同一「机器不可用」语义关闭，前端重进时重新建连。
    const relayPort = tryGetRelayLifecyclePort();
    if (relayPort) {
      for (const instanceId of instanceUids) {
        relayPort.closeClientsByInstance(instanceId, WEBSOCKET_CODES.MACHINE_UNAVAILABLE.code, "machine unavailable");
      }
    }
  }

  return removed;
}
