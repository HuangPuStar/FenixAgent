import type * as acp from "@agentclientprotocol/sdk";
import { createErrorResponse, createForwardedErrorResponse, createSuccessResponse } from "./json-rpc.js";

/** session/input/*（Peri steer）透传所需的最小上下文。 */
export interface UserInputQueueForwardContext {
  connection: acp.ClientSideConnection | null;
  send: (message: unknown) => void;
  id: number | string;
  method: string;
  params: unknown;
}

/**
 * 把 session/input/snapshot|enqueue|dispatch|takeback 原样经 SDK extMethod 发往 agent。
 *
 * SDK 没有这四个方法的原语，extMethod 是唯一可用入口。params（含 ACP ses_* 形态的
 * sessionId 与 generation/commandId/inputId）不做字段过滤、ID 换算或补默认值；agent
 * 回来的 JSON-RPC 错误（-32601 未协商、-32602 generation 不符并带 data.rejected）经
 * createForwardedErrorResponse 逐字段回传，不重试、不降级成空成功。
 *
 * client mode（AcpDispatcher.handleRequest）与 server mode（server.ts
 * dispatchIncomingMessage）共用此处，避免两条 relay 路径行为分叉。
 */
export async function forwardUserInputQueueRequest(context: UserInputQueueForwardContext): Promise<void> {
  const { connection, send, id, method, params } = context;
  if (!connection) {
    send(createErrorResponse(id, -32000, "Not connected to agent"));
    return;
  }
  try {
    const result = await connection.extMethod(method, (params ?? {}) as Record<string, unknown>);
    send(createSuccessResponse(id, result));
  } catch (error) {
    console.error(
      "[acp-dispatcher] ✗ user input queue error:",
      JSON.stringify({ method, id, error: (error as Error).message }),
    );
    send(createForwardedErrorResponse(id, error, `${method} failed: ${(error as Error).message}`));
  }
}
