import { registryEvent } from "@server/db/schema";
import { getMachineDatabase } from "../db";

function generateRegistryEventId(): string {
  return `evt_${crypto.randomUUID().slice(0, 22)}`;
}

/**
 * 写入一条机器注册事件。
 *
 * 事件业务语义由调用方定义；本函数只负责生成事件 ID 并持久化。
 */
export async function writeRegistryEvent(
  machineId: string,
  type: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const db = getMachineDatabase();
  await db.insert(registryEvent).values({
    id: generateRegistryEventId(),
    machineId,
    type,
    detail,
  });
}
