import { closeRelayClientsForMachine } from "./lifecycle-port";

/** 精确关闭指定实例的前端 YJS WebSocket client。 */
export function closeClientsForMachineInstances(instanceIds: readonly string[], reason: string): void {
  for (const instanceId of instanceIds) {
    closeRelayClientsForMachine(instanceId, reason);
  }
}
