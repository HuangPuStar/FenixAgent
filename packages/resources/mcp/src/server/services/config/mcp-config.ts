/**
 * MCP Server 的配置模型、校验与展示投影。
 *
 * 这些定义原先散落在 `services/config/mcp-server.ts`（旧栈，含授权读取）与宿主
 * `apps/server/src/services/config/types.ts`。配置模型属于 MCP 资源包本身：资源包需要它做校验、
 * 类型归一与展示，宿主只是转发方（宿主类型再导出本模块，不再是定义方）。
 *
 * 纯函数、无 IO、无权限判断：路由用它做协议层输入校验，Domain Service 用它推导存储列取值。
 */

/** MCP server type discriminator */
export type McpServerType = "local" | "remote" | "streamable-http";

/** OAuth configuration for remote MCP servers */
export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
}

/** Local MCP server config (command-based) */
export interface McpLocalConfig {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
}

/** Remote MCP server config (URL-based, SSE transport) */
export interface McpRemoteConfig {
  type: "remote";
  url: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig | false;
  timeout?: number;
}

/** Streamable HTTP MCP server config */
export interface McpStreamableHttpConfig {
  type: "streamable-http";
  url: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  timeout?: number;
}

/** Disabled MCP server config (minimal) */
export interface McpDisabledConfig {
  enabled: false;
}

/** Union of all MCP server config variants */
export type McpServerConfig = McpLocalConfig | McpRemoteConfig | McpStreamableHttpConfig | McpDisabledConfig;

/**
 * 列表/详情展示信息。
 *
 * 不含任何访问信息：`/web` 视图的访问信息来自资源授权层的 `scope` + `access`，对外 `/api` 视图由
 * 协议 adapter 从同一份 `access` 派生旧字段形状，两者都不在这里二次推导。
 */
export interface McpServerInfo {
  name: string;
  type: McpServerType | "disabled";
  enabled: boolean;
  summary: string;
  timeout?: number;
}

/** 允许的 MCP 服务器类型 */
export const VALID_MCP_TYPES: readonly McpServerType[] = ["local", "remote", "streamable-http"];

/** MCP 服务器名称校验 */
export function isValidMcpName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= 64 &&
    !/--/.test(name) &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)
  );
}

/** 校验 MCP 配置结构，返回错误码或 null */
export function validateMcpConfig(config: unknown): string | null {
  if (typeof config !== "object" || config === null) return "INVALID_CONFIG";
  const cfg = config as Record<string, unknown>;

  if ("enabled" in cfg && cfg.enabled === false && Object.keys(cfg).length === 1) return null;

  if (!("type" in cfg) || typeof cfg.type !== "string") return "INVALID_CONFIG_TYPE";
  const type = cfg.type as string;

  if (type === "local") {
    if (
      !Array.isArray(cfg.command) ||
      cfg.command.length === 0 ||
      cfg.command.some((c: unknown) => typeof c !== "string")
    ) {
      return "INVALID_COMMAND";
    }
    if (cfg.environment !== undefined && (typeof cfg.environment !== "object" || cfg.environment === null)) {
      return "INVALID_ENVIRONMENT";
    }
    if (cfg.timeout !== undefined && (typeof cfg.timeout !== "number" || cfg.timeout <= 0)) {
      return "INVALID_TIMEOUT";
    }
  } else if (type === "remote" || type === "streamable-http") {
    if (typeof cfg.url !== "string" || cfg.url.length === 0) return "INVALID_URL";
    if (cfg.headers !== undefined && (typeof cfg.headers !== "object" || cfg.headers === null)) {
      return "INVALID_HEADERS";
    }
    if (cfg.timeout !== undefined && (typeof cfg.timeout !== "number" || cfg.timeout <= 0)) {
      return "INVALID_TIMEOUT";
    }
  } else {
    return "INVALID_CONFIG_TYPE";
  }
  return null;
}

/** 未知取值（历史数据、外部写入）一律归为 `local`：与迁移前 `toServerInfo` 的兜底一致。 */
export function normalizeMcpServerType(type: unknown): McpServerType {
  return type === "remote" || type === "streamable-http" ? type : "local";
}

/**
 * 读取配置对象里的服务类型，用于写入 `mcp_server.type` 归属列。
 *
 * 与 `normalizeMcpServerType` 的分工：后者服务展示投影，把任何未知取值归一到三种已知类型；
 * 这里保留原样字符串，因为写入前 `McpServerFacade` 已用 `validateMcpConfig` 判定合法性，不应在此静默纠正。
 */
export function readMcpServerType(config: McpServerConfig): string {
  const type = (config as { type?: unknown }).type;
  return typeof type === "string" ? type : "local";
}

/**
 * 读取 jsonb 配置值，兼容历史上"双重编码"的字符串行。
 *
 * 与宿主 `services/config/jsonb.ts` 的 `parseJsonb` 同因（Drizzle 已自动解析 jsonb，字符串只可能
 * 来自历史写入 bug），但这里不引入宿主内部路径：资源包不得依赖 `apps/server` 的实现文件。1.5 把
 * JSONB 工具收敛到 `platform-sdk` 后本函数应替换为该公共工具。
 */
export function parseMcpConfigValue(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value !== "string") return value as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "string") {
      const nested: unknown = JSON.parse(parsed);
      return typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : null;
    }
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 将 PG 行数据转为前端展示信息 */
export function toServerInfo(name: string, row: { type: string; config: unknown; enabled: boolean }): McpServerInfo {
  const config = parseMcpConfigValue(row.config) ?? {};
  if (!row.enabled && !("type" in config)) {
    return { name, type: "disabled", enabled: false, summary: "已禁用" };
  }
  const cfgType = config.type as string;
  if (cfgType === "local") {
    const command = Array.isArray(config.command) ? (config.command as string[]) : [];
    return {
      name,
      type: "local",
      enabled: row.enabled,
      summary: command[0] ?? "",
      timeout: config.timeout as number | undefined,
    };
  }
  // streamable-http 和 remote 统一展示（使用 URL）
  return {
    name,
    type: cfgType === "streamable-http" ? "streamable-http" : "remote",
    enabled: row.enabled,
    summary: (config.url as string) ?? "",
    timeout: config.timeout as number | undefined,
  };
}
