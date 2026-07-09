import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { ACP_METHOD, createNotification } from "../json-rpc.js";

export interface SpawnResult {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  capabilities: Record<string, unknown>;
  /**
   * 处理前端返回的权限响应，匹配 requestPermission 创建的待决 Promise。
   * caller 应将其桥接到 AcpDispatcher，使前端响应能路由回 opencode 的 requestPermission。
   */
  resolvePermissionOutcome: (requestId: string, outcome: acp.RequestPermissionOutcome) => boolean;
}

/** pending 超时毫秒数：超过此时间未收到前端响应则自动取消 */
const PERMISSION_TIMEOUT_MS = 30_000;

/**
 * spawn ACP 子进程并初始化 ClientSideConnection。
 * opencode 和 ccb handler 共用此逻辑。
 */
export async function spawnAcpAgent(
  executable: string,
  args: string[],
  workspace: string,
  launchSpecEnv: Record<string, string> | undefined,
  send: (message: unknown) => void,
): Promise<SpawnResult> {
  const spawnEnv = launchSpecEnv ? { ...process.env, ...launchSpecEnv } : { ...process.env };

  const proc = spawn(executable, args, {
    cwd: workspace,
    stdio: ["pipe", "pipe", "inherit"],
    env: spawnEnv,
  });

  const input = Writable.toWeb(proc.stdin!) as unknown as WritableStream<Uint8Array>;
  const output = Readable.toWeb(proc.stdout!) as unknown as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  // pending 权限请求 — requestPermission 创建，resolvePermissionOutcome 消费
  const pendingPermissions = new Map<
    string,
    {
      resolve: (outcome: acp.RequestPermissionOutcome) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** 桥接函数：当 AcpDispatcher 收到前端权限响应时调用 */
  const resolvePermissionOutcome = (requestId: string, outcome: acp.RequestPermissionOutcome): boolean => {
    // "__cancel_all__" 哨兵：批量取消所有待决权限请求。
    // 当前端 relay 全部断开时，AcpDispatcher 通过 onPermissionOutcome 回调
    // 传入此哨兵，一次性清除 spawnAcpAgent 侧的所有 pending 权限请求。
    if (requestId === "__cancel_all__") {
      for (const [key, pending] of pendingPermissions) {
        clearTimeout(pending.timer);
        pending.resolve({ outcome: "cancelled" });
      }
      pendingPermissions.clear();
      return true;
    }
    const pending = pendingPermissions.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingPermissions.delete(requestId);
    pending.resolve(outcome);
    return true;
  };

  const connection = new acp.ClientSideConnection(
    () => ({
      requestPermission: async (params: Record<string, unknown>) => {
        // ACP spec: params 包含 sessionId、options、toolCall
        const sessionId = (params?.sessionId as string) ?? (params as { session_id?: string }).session_id ?? "";
        const toolCall = (params?.toolCall as Record<string, unknown>) ?? {};
        const toolCallId = (toolCall?.toolCallId as string) ?? (toolCall?.tool_call_id as string) ?? "";
        const title = (toolCall?.title as string) ?? `OpenCode tool: ${toolCallId}`;
        const reqOptions = Array.isArray(params?.options) ? (params.options as acp.PermissionOption[]) : [];

        // 生成唯一 requestId（前端 response 通过此 id 匹配）
        const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        // 透传 opencode 定义的选项，附加 reject_once 兜底
        const frontendOptions =
          reqOptions.length > 0
            ? reqOptions
            : [
                { kind: "allow_once" as const, name: "Allow Once", optionId: "allow_once" },
                { kind: "reject_once" as const, name: "Deny", optionId: "reject_once" },
              ];

        const outcome = await new Promise<acp.RequestPermissionOutcome>((resolve) => {
          const timer = setTimeout(() => {
            console.log(`[acp-spawn-helper] requestPermission TIMEOUT: requestId=${requestId}`);
            pendingPermissions.delete(requestId);
            resolve({ outcome: "cancelled" });
          }, PERMISSION_TIMEOUT_MS);
          pendingPermissions.set(requestId, { resolve, timer });

          send({
            type: "permission_request",
            payload: {
              sessionId,
              requestId,
              options: frontendOptions,
              toolCall: { toolCallId, title },
              toolName: title,
              description: title,
            },
          });
        });

        return { outcome };
      },
      sessionUpdate: async (params: Record<string, unknown>) => {
        send(createNotification(ACP_METHOD.SESSION_UPDATE, params));
      },
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    }),
    stream,
  );

  const initResult = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientInfo: { name: "rcs-remote", version: "1.0.0" },
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });

  return {
    process: proc,
    connection,
    capabilities: (initResult.agentCapabilities as Record<string, unknown>) ?? {},
    resolvePermissionOutcome,
  };
}
