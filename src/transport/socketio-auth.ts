import type { IncomingMessage } from "node:http";
import type { Socket } from "socket.io";
import { AppError } from "../errors";
import type { RequestAuthResult } from "../plugins/auth";
import { authenticateRequest } from "../plugins/auth";

/**
 * 将 Node IncomingMessage 转换为 Fetch API Request，供 authenticateRequest 使用。
 * @private 内部由 socketio-auth 模块使用
 */
/** @internal 供测试使用 */
export function incomingToRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }
  }

  const protocol = (req.headers["x-forwarded-proto"] as string) === "https" ? "https" : "http";
  const host = (req.headers.host as string) || "localhost";
  const url = req.url || "/";
  const fullUrl = `${protocol}://${host}${url}`;

  return new Request(fullUrl, { headers });
}

/** /relay namespace 认证后的 socket.data 结构 */
export interface RelaySocketData {
  authResult: RequestAuthResult;
  userId: string;
  agentId: string;
  sessionId?: string;
}

/**
 * /relay namespace 的认证中间件。
 *
 * 验证用户 cookie → 提取 agentId → 校验 agent 存在性和组织权限。
 * 认证通过后填充 socket.data 为强类型 RelaySocketData。
 *
 * @param socket - socket.io Socket 实例
 * @param next   - 认证结果回调：next() 通过，next(error) 拒绝
 */
export async function relayAuthMiddleware(socket: Socket, next: (err?: Error) => void): Promise<void> {
  let authResult: RequestAuthResult | null = null;
  const request = incomingToRequest(socket.request);
  try {
    authResult = await authenticateRequest(request);
  } catch (err) {
    if (err instanceof AppError && err.code === "RATE_LIMITED") {
      return next(new Error("rate_limited"));
    }
    return next(new Error("unauthorized"));
  }
  if (!authResult?.user) {
    return next(new Error("unauthorized"));
  }

  const agentId = socket.handshake.query.agentId as string;
  if (!agentId) {
    return next(new Error("missing agentId"));
  }

  // 填充 socket.data
  const data: RelaySocketData = {
    authResult,
    userId: authResult.user.id,
    agentId,
    sessionId: (socket.handshake.query.sessionId as string) || undefined,
  };
  socket.data = data;

  // Verify agent exists and check org permissions
  const { environmentRepo } = await import("../repositories/environment");
  const env = await environmentRepo.getById(agentId);
  if (!env) {
    return next(new Error("agent not found"));
  }

  const userId = authResult.user.id;
  const authCtx = authResult.authContext;
  const forbiddenSharedRuntime = Boolean(env.agentConfigId && env.userId !== userId);
  if (!authCtx || forbiddenSharedRuntime || (env.organizationId !== authCtx.organizationId && env.userId !== userId)) {
    return next(new Error("unauthorized"));
  }

  next();
}
