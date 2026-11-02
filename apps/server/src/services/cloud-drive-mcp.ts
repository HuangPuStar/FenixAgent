import type { AgentLaunchSpec, McpServerConfig, SessionMcpServersProvider } from "@fenix/agent-runtime/server";
import { type CloudDriveModuleConfig, issueCloudDriveMcpToken } from "@fenix/resource-cloud-drive/server";

/**
 * 通道 A：把平台托管的 CloudDrive MCP 条目追加进 LaunchSpec。
 *
 * 与知识库 `kb` 条目同一形状（`streamable-http` + Bearer），差异只在凭据：`kb` 用 Environment Secret，
 * 云盘用按用户/组织签发的 HMAC token。token 会随 `.mcp.json` 落到实例工作区，所以默认 TTL 较长
 * （`CLOUDDRIVE_MCP_LAUNCH_TTL_SECONDS`）；交互式 Chat 走的通道 B 不落盘、TTL 更短。
 *
 * 失败口径：
 * - CloudDrive 未配置（baseUrl/masterKey 缺失）→ 跳过，实例照常启动；
 * - token secret 缺失 → 跳过（网关同时 503），由调用方记 warning；
 * - 用户 MCP 已占用保留名 `cloud-drive` → **抛错**，与 `mcp-resolution` 的严格口径一致：
 *   静默覆盖会让用户在控制台配置的服务悄悄消失。
 */

/** 平台保留名；用户 MCP 不得占用。 */
export const CLOUD_DRIVE_MCP_SERVER_NAME = "cloud-drive";

/** 用户 MCP 与平台保留名冲突；宿主必须让启动失败，而不是静默覆盖。 */
export class CloudDriveMcpNameConflictError extends Error {
  constructor() {
    super(
      `MCP 服务名 '${CLOUD_DRIVE_MCP_SERVER_NAME}' 是平台保留名（个人云盘托管入口），请为用户 MCP 改名后再启动实例`,
    );
    this.name = "CloudDriveMcpNameConflictError";
  }
}

export interface CloudDriveMcpInjectionInput {
  readonly spec: AgentLaunchSpec;
  readonly config: CloudDriveModuleConfig;
  /** Fenix 对外基址（`getBaseUrl()`），末尾斜杠会被去掉。 */
  readonly baseUrl: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly nowSeconds?: number;
}

export type CloudDriveMcpSkipReason = "cloud-drive-not-configured" | "missing-token-secret";

export interface CloudDriveMcpInjectionResult {
  readonly spec: AgentLaunchSpec;
  /** 有值表示本次没有下发条目；调用方据此记录 warning（不阻断启动）。 */
  readonly skipped?: CloudDriveMcpSkipReason;
}

/** 判断 CloudDrive 本体是否可用；与 `/web/cloud-drive/*` 的 503 判据一致。 */
export function isCloudDriveConfigured(config: CloudDriveModuleConfig): boolean {
  return Boolean(config.baseUrl?.trim() && config.masterKey?.trim());
}

/**
 * 在已组装好的 LaunchSpec 上追加 `cloud-drive` 条目。
 *
 * 只由宿主 `pre-launch-ports` 在 `buildAgentLaunchSpec` 之后调用；`buildMinimalLaunchSpec` 不下发
 * （最小启动路径没有 AgentConfig，也没有可归属的用户配置）。
 */
export async function withCloudDriveMcpServer(
  input: CloudDriveMcpInjectionInput,
): Promise<CloudDriveMcpInjectionResult> {
  if (!isCloudDriveConfigured(input.config)) return { spec: input.spec, skipped: "cloud-drive-not-configured" };
  if (!input.config.mcpTokenSecret?.trim()) return { spec: input.spec, skipped: "missing-token-secret" };

  if (input.spec.mcpServers.some((server) => server.name === CLOUD_DRIVE_MCP_SERVER_NAME)) {
    throw new CloudDriveMcpNameConflictError();
  }

  const token = await issueCloudDriveMcpToken({
    userId: input.userId,
    organizationId: input.organizationId,
    scope: input.config.mcpScope,
    ttlSeconds: input.config.mcpLaunchTtlSeconds,
    secret: input.config.mcpTokenSecret,
    ...(input.nowSeconds === undefined ? {} : { nowSeconds: input.nowSeconds }),
  });

  const entry: McpServerConfig = {
    name: CLOUD_DRIVE_MCP_SERVER_NAME,
    type: "streamable-http",
    url: `${input.baseUrl.replace(/\/$/, "")}/mcp/cloud-drive`,
    headers: { Authorization: `Bearer ${token}` },
    timeout: input.config.mcpTimeoutMs,
  };

  return { spec: { ...input.spec, mcpServers: [...input.spec.mcpServers, entry] } };
}

export interface CloudDriveSessionMcpProviderDeps {
  /** Fenix 对外基址（`getBaseUrl()`）。 */
  readonly baseUrl: () => string;
  readonly config: () => CloudDriveModuleConfig;
  readonly nowSeconds?: () => number;
}

/**
 * 通道 B：交互式 Chat 的会话级条目。
 *
 * 与通道 A 的差异是刻意的：条目只进 ACP 消息（不写 `.mcp.json`），TTL 取
 * `CLOUDDRIVE_MCP_TOKEN_TTL_SECONDS`（默认 1h）。peri 消费 ACP `mcpServers`；其他引擎适配器忽略
 * 会话级条目，继续依赖通道 A 的环境级配置。
 *
 * 返回 `undefined` 表示本次不注入（未配置/缺组织/缺 secret）；provider 抛出会被 agent-runtime
 * 捕获并降级，不会阻断建会话。
 */
export function createCloudDriveSessionMcpProvider(deps: CloudDriveSessionMcpProviderDeps): SessionMcpServersProvider {
  return async (context) => {
    const config = deps.config();
    if (!isCloudDriveConfigured(config) || !config.mcpTokenSecret?.trim()) return;
    if (!context.organizationId) return;

    const token = await issueCloudDriveMcpToken({
      userId: context.userId,
      organizationId: context.organizationId,
      scope: config.mcpScope,
      ttlSeconds: config.mcpTokenTtlSeconds,
      secret: config.mcpTokenSecret,
      ...(deps.nowSeconds === undefined ? {} : { nowSeconds: deps.nowSeconds() }),
    });

    return [
      {
        type: "http",
        name: CLOUD_DRIVE_MCP_SERVER_NAME,
        url: `${deps.baseUrl().replace(/\/$/, "")}/mcp/cloud-drive`,
        headers: [{ name: "Authorization", value: `Bearer ${token}` }],
      },
    ];
  };
}
