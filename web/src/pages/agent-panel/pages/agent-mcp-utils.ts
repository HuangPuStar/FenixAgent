import * as z from "zod/v4";
import { getMcpDisplayName } from "../../../lib/mcp-resource-access";
import type { McpServerConfig, McpServerInfo } from "../../../types/config";

export type McpCatalogScope = "all" | "organization" | "shared";
export type KeyValueEntry = { key: string; value: string };
export type McpImportEntry = { name: string; config: McpServerConfig };
export type McpImportErrorKey =
  | "validation.importInvalidJson"
  | "validation.importInvalidRoot"
  | "validation.importEmpty"
  | "validation.importInvalidName"
  | "validation.importInvalidConfig";

export class McpImportError extends Error {
  constructor(readonly key: McpImportErrorKey) {
    super(key);
    this.name = "McpImportError";
  }
}

const StringRecordSchema = z.record(z.string(), z.string());
const ImportServerSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: StringRecordSchema.optional(),
    environment: StringRecordSchema.optional(),
    url: z.url().optional(),
    headers: StringRecordSchema.optional(),
    oauth: z
      .object({
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        scope: z.string().optional(),
        redirectUri: z.string().optional(),
      })
      .optional(),
    timeout: z.number().int().positive().optional(),
    type: z.enum(["stdio", "sse", "http", "streamable-http", "local", "remote"]).optional(),
  })
  .strict();

/** 解析标准 mcp.json，并在边界处转换为平台内部 MCP 配置。 */
export function parseMcpJson(input: string): McpImportEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new McpImportError("validation.importInvalidJson");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new McpImportError("validation.importInvalidRoot");
  }

  const root = parsed as Record<string, unknown>;
  const rawServers = "mcpServers" in root ? root.mcpServers : root;
  if (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers)) {
    throw new McpImportError("validation.importInvalidRoot");
  }

  const entries = Object.entries(rawServers);
  if (entries.length === 0) throw new McpImportError("validation.importEmpty");
  return entries.map(([name, rawConfig]) => {
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name) || name.length > 64) {
      throw new McpImportError("validation.importInvalidName");
    }
    const result = ImportServerSchema.safeParse(rawConfig);
    if (!result.success) throw new McpImportError("validation.importInvalidConfig");
    const config = result.data;

    if (config.command) {
      if (config.url || (config.type && !["stdio", "local"].includes(config.type))) {
        throw new McpImportError("validation.importInvalidConfig");
      }
      return {
        name,
        config: {
          type: "local",
          command: [config.command, ...(config.args ?? [])],
          ...(config.env || config.environment ? { environment: config.env ?? config.environment } : {}),
          ...(config.timeout ? { timeout: config.timeout } : {}),
        },
      };
    }

    if (!config.url || (config.type && ["stdio", "local"].includes(config.type))) {
      throw new McpImportError("validation.importInvalidConfig");
    }
    const type = config.type === "http" || config.type === "streamable-http" ? "streamable-http" : "remote";
    return {
      name,
      config: {
        type,
        url: config.url,
        ...(config.headers ? { headers: config.headers } : {}),
        ...(config.oauth ? { oauth: config.oauth } : {}),
        ...(config.timeout ? { timeout: config.timeout } : {}),
      },
    };
  });
}

/** 校验 MCP 编辑器必填字段，返回可直接展示的 i18n key。 */
export function validateMcpEditor(input: {
  name: string;
  type: "local" | "remote";
  command: string;
  url: string;
}): string | null {
  if (!input.name.trim()) return "validation.nameRequired";
  if (/--/.test(input.name)) return "validation.nameNoDoubleHyphen";
  if (!/^[\p{L}0-9](?:[\p{L}0-9-]*[\p{L}0-9])?$/u.test(input.name)) return "validation.namePattern";
  if (input.name.length > 64) return "validation.nameTooLong";
  if (input.type === "local" && parseMcpCommand(input.command).length === 0) return "validation.commandRequired";
  if (input.type === "remote") {
    if (!input.url.trim()) return "validation.urlRequired";
    try {
      new URL(input.url);
    } catch {
      return "validation.urlInvalid";
    }
  }
  return null;
}

/** 将命令行展示值拆成 MCP local config 使用的 argv。 */
export function parseMcpCommand(input: string): string[] {
  const tokens: string[] = [];
  const regex = /(?:[^\s"]+|"[^"]*")+/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: 正则迭代需要保留 match 供循环体读取。
  while ((match = regex.exec(input)) !== null) tokens.push(match[0].replace(/^"|"$/g, ""));
  return tokens;
}

/** 将 argv 转为可编辑且可逆的命令行展示值。 */
export function stringifyMcpCommand(command: string[]): string {
  return command.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

/** 在提交边界把编辑器视图模型转换为真实 MCP 配置。 */
export function buildMcpPayload(input: {
  type: "local" | "remote";
  command: string;
  url: string;
  environment: KeyValueEntry[];
  headers: KeyValueEntry[];
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
  oauthRedirectUri: string;
  timeout: string;
}): McpServerConfig {
  const timeout = input.timeout ? Number.parseInt(input.timeout, 10) : undefined;
  const environment = entriesToRecord(input.environment);
  const headers = entriesToRecord(input.headers);
  if (input.type === "local") {
    return {
      type: "local",
      command: parseMcpCommand(input.command),
      ...(environment ? { environment } : {}),
      ...(timeout ? { timeout } : {}),
    };
  }
  const oauth =
    input.oauthClientId || input.oauthClientSecret || input.oauthScope || input.oauthRedirectUri
      ? {
          clientId: input.oauthClientId || undefined,
          clientSecret: input.oauthClientSecret || undefined,
          scope: input.oauthScope || undefined,
          redirectUri: input.oauthRedirectUri || undefined,
        }
      : undefined;
  return {
    type: "remote",
    url: input.url,
    ...(headers ? { headers } : {}),
    ...(oauth ? { oauth } : {}),
    ...(timeout ? { timeout } : {}),
  };
}

/** 依据真实资源归属和查询条件筛选插件。 */
export function filterMcpServers(servers: McpServerInfo[], query: string, scope: McpCatalogScope): McpServerInfo[] {
  const keyword = query.trim().toLowerCase();
  return servers.filter((server) => {
    const shared = server.resourceAccess?.ownership === "external";
    if (scope === "organization" && shared) return false;
    if (scope === "shared" && !shared) return false;
    if (!keyword) return true;
    return [getMcpDisplayName(server), server.name, server.summary, server.type]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(keyword);
  });
}

/** 返回插件目录的真实归属计数。 */
export function countMcpScopes(servers: McpServerInfo[]) {
  const shared = servers.filter((server) => server.resourceAccess?.ownership === "external").length;
  return { organization: servers.length - shared, shared };
}

function entriesToRecord(entries: KeyValueEntry[]): Record<string, string> | undefined {
  const valid = entries.filter((entry) => entry.key.trim());
  return valid.length > 0 ? Object.fromEntries(valid.map((entry) => [entry.key, entry.value])) : undefined;
}
