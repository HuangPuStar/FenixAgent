import { getChatChannelController } from "../../services/chat-channel-bootstrap";

/** 精确关闭指定实例的前端 YJS WebSocket client。 */
export function closeClientsForMachineInstances(instanceIds: readonly string[], reason: string): void {
  for (const instanceId of instanceIds) {
    getChatChannelController().registry.closeClientsByInstance(instanceId, 4500, reason);
  }
}
