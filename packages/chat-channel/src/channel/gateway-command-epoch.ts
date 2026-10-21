import type { WsConnection } from "./connection-types";
import type { GatewayDependencies } from "./gateway";

/** 新命令代次遵循普通背压；不可交付时断开重连，不能静默留下过期客户端。 */
export function bindGatewayCommandEpoch(
  dependencies: Pick<GatewayDependencies, "registry" | "sessionChannel" | "broadcaster" | "reportError">,
): (ws: WsConnection) => boolean {
  const report = (context: string, error: unknown) => {
    try {
      dependencies.reportError(context, error instanceof Error ? error.name : typeof error);
    } catch {
      // 诊断失败不能阻断当前连接关闭或其他客户端的新代次广播。
    }
  };
  const send = (ws: WsConnection): boolean => {
    try {
      if (ws.readyState !== 1) return false;
      if (
        dependencies.broadcaster.sendToYjsWs(ws, {
          type: "yjs:command-epoch",
          epoch: dependencies.sessionChannel.getCommandEpoch(),
        })
      )
        return true;
    } catch (error) {
      report("[YJS-FE] command epoch delivery failed", error);
    }
    try {
      ws.close(1013, "command epoch unavailable");
    } catch (closeError) {
      report("[YJS-FE] command epoch close failed", closeError);
    }
    return false;
  };
  dependencies.sessionChannel.onCommandEpochChanged(() => {
    dependencies.registry.forEachClient((entry) => send(entry.ws));
  });
  return send;
}
