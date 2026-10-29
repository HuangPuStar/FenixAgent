import { error as logError } from "@fenix/logger";

/**
 * 会话级 MCP 条目提供方（通道 B）的宿主注入点。
 *
 * 为什么是「注入」而不是 `agent-runtime` 直接依赖云盘资源包：依赖矩阵禁止 agent-runtime 反向依赖
 * `packages/resources/*`。宿主在启动装配阶段注册一次，本包只负责在 `session/new|load|resume`
 * 之前调用它，把结果原样交给 ACP。
 *
 * 约定：
 * 1. 提供方返回的条目只进 ACP 消息，本包不落盘、不缓存、不记录；
 * 2. 提供方失败或未注册时降级为「本次不注入」，绝不能因为一个 MCP 连接问题阻断用户建会话；
 * 3. 上下文只含服务端权威字段（用户/组织/实例），不接受浏览器输入。
 */
export interface SessionMcpContext {
  readonly userId: string;
  readonly organizationId?: string;
  /** 环境 ID（Chat 域的 `agentId` 即 environment.id）。 */
  readonly agentId: string;
  readonly instanceId: string;
  readonly rcsSessionId?: string;
}

export type SessionMcpServersProvider = (
  context: SessionMcpContext,
) => Promise<readonly Record<string, unknown>[] | undefined>;

let provider: SessionMcpServersProvider | undefined;

/** 宿主注册入口；传 `undefined` 清除（测试收尾）。 */
export function setSessionMcpServersProvider(next: SessionMcpServersProvider | undefined): void {
  provider = next;
}

/** 解析会话级 MCP 条目；语义见文件头。 */
export async function resolveSessionMcpServers(
  context: SessionMcpContext,
): Promise<readonly Record<string, unknown>[] | undefined> {
  if (!provider) return;
  try {
    const servers = await provider(context);
    return servers && servers.length > 0 ? servers : undefined;
  } catch (error) {
    logError("会话级 MCP 条目解析失败，本次会话不注入", error instanceof Error ? error : undefined);
    return;
  }
}
