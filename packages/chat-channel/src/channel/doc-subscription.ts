import type { ClientConnection } from "./connection-types";

/** 内容 socket 使用分页协议；动作 socket 仅订阅自己 scope 的 Session 状态。 */
export function canDeliverLegacyDoc(client: ClientConnection, docName: string): boolean {
  return !client.syncOnly && docName === `session:${client.rcsSessionId}`;
}
