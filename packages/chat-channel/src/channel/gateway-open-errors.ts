// packages/chat-channel/src/channel/gateway-open-errors.ts
// Gateway 连接拒绝与公开错误投影：从 gateway.ts 拆出，保持单文件 ≤500 行。
// 只做错误构造、诊断日志与发送，不参与连接状态机。

import { createPublicError, type PublicError, type PublicErrorType, serializePublicErrorLog } from "../public-error";
import type { YjsBroadcaster } from "./broadcaster";
import type { ConnectionRegistry } from "./connection-registry";
import type { WsConnection } from "./connection-types";

/** 连接拒绝/错误投影所需的最小依赖面。 */
export interface GatewayErrorDependencies {
  readonly registry: Pick<ConnectionRegistry, "discardPending">;
  readonly reportLog: (message: string) => void;
  readonly broadcaster: Pick<YjsBroadcaster, "sendToYjsWs">;
}

/** 发送公开错误帧并写安全诊断日志；返回构造的错误对象供调用方继续使用。 */
export function sendGatewayPublicError(
  deps: GatewayErrorDependencies,
  ws: WsConnection,
  type: PublicErrorType,
  stage: string,
): PublicError {
  const error = createPublicError(type);
  deps.reportLog(serializePublicErrorLog(error, stage));
  deps.broadcaster.sendToYjsWs(ws, { type: "error", payload: error });
  return error;
}

/** 拒绝连接：先清理 pending，再尽力发送公开错误与关闭帧。 */
export function rejectGatewayOpen(
  deps: GatewayErrorDependencies,
  ws: WsConnection,
  wsId: string,
  closeCode: number,
  closeReason: string,
  type: PublicErrorType,
): void {
  deps.registry.discardPending(wsId);
  try {
    sendGatewayPublicError(deps, ws, type, "gateway.open");
  } catch {
    /* ignore */
  }
  try {
    ws.close(closeCode, closeReason);
  } catch {
    /* ignore */
  }
}

/** 实例启动永久失败码 → 公开错误分类。 */
export function mapPermanentSpawnFailure(code: string): PublicErrorType {
  if (code === "instance_limit_reached") return "CONTROL_PLANE.INSTANCE_LIMIT_REACHED";
  if (code === "auto_start_disabled" || code === "configuration_invalid") {
    return "CONTROL_PLANE.CONFIGURATION_INVALID";
  }
  return "CONTROL_PLANE.INSTANCE_START_FAILED";
}
