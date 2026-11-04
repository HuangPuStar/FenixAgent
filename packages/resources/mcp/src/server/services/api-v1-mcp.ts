import { type ActorContext, NotFoundError, ValidationError } from "@fenix/platform-sdk";
import type { AuthorizedMcpServer } from "../facades/mcp-server-facade";
import { getMcpServerModule } from "../runtime";
import type { ApiMcpCreateBody, ApiMcpUpdateBody } from "../schemas/api-mcp.schema";
import { type McpServerConfig, parseMcpConfigValue, validateMcpConfig } from "./config/mcp-config";

/** Credentials can occur in URL authority and query as well as explicit secret fields. */
function publicUrl(value: unknown): URL | undefined {
  if (typeof value !== "string") return;
  const url = URL.parse(value);
  if (!url || !["https:", "http:"].includes(url.protocol)) return;
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url;
}

/** Independent safe v1 projection; never return credential values or masks. */
export function toApiMcp(server: AuthorizedMcpServer, toolsCount = 0) {
  const raw = parseMcpConfigValue(server.config) ?? {};
  const type = raw.type === "remote" || raw.type === "streamable-http" ? raw.type : "local";
  const oauth = raw.oauth && typeof raw.oauth === "object" ? (raw.oauth as Record<string, unknown>) : undefined;
  const url = publicUrl(raw.url);
  const summary =
    typeof raw.url === "string" ? (url?.origin ?? "") : Array.isArray(raw.command) ? String(raw.command[0] ?? "") : "";
  const config: Record<string, unknown> = { type, enabled: server.enabled ?? true };
  for (const key of ["command", "timeout"]) if (raw[key] !== undefined) config[key] = raw[key];
  if (url) config.url = url.toString();
  if (oauth) {
    config.oauth = Object.fromEntries(
      ["clientId", "scope"].filter((key) => typeof oauth[key] === "string").map((key) => [key, oauth[key]]),
    );
    const redirect = publicUrl(oauth.redirectUri);
    if (redirect) (config.oauth as Record<string, unknown>).redirectUri = redirect.toString();
  } else if (raw.oauth === false) config.oauth = false;
  return {
    id: server.id,
    name: server.name,
    type,
    enabled: server.enabled ?? true,
    summary,
    toolsCount,
    scope: server.scope,
    access: server.access,
    config,
    headerNames: Object.keys((raw.headers ?? {}) as object),
    environmentNames: Object.keys((raw.environment ?? {}) as object),
    hasClientSecret: typeof oauth?.clientSecret === "string" && oauth.clientSecret.length > 0,
  };
}
/** Version-owned action orchestration, delegating permissions and writes to MCP owner. */
export class ApiV1McpService {
  private get facade() {
    return getMcpServerModule().facade;
  }
  async get(actor: ActorContext, id: string) {
    const row = await this.facade.getById(actor, id);
    if (!row) throw new NotFoundError("MCP not found");
    return toApiMcp(row);
  }
  async list(actor: ActorContext, query: { page: number; pageSize: number }) {
    const result = await this.facade.list(actor, { limit: query.pageSize, offset: (query.page - 1) * query.pageSize });
    return {
      ...query,
      total: result.total,
      items: result.items.map((row) => {
        const { config, headerNames, environmentNames, hasClientSecret, ...item } = toApiMcp(row, row.toolsCount);
        return item;
      }),
    };
  }
  async create(actor: ActorContext, input: ApiMcpCreateBody) {
    const id = await this.facade.create(actor, {
      name: input.name,
      type: input.config.type,
      config: input.config,
      publicReadable: input.publicReadable,
    });
    return this.get(actor, id);
  }
  async patch(actor: ActorContext, id: string, input: ApiMcpUpdateBody) {
    if ("enabled" in input) {
      if (input.enabled) {
        const row = await this.facade.getWritableById(actor, id);
        const cfg = parseMcpConfigValue(row.config);
        if (!cfg || validateMcpConfig({ ...cfg, enabled: true }))
          throw new ValidationError("Complete connection configuration required");
      }
      await this.facade.setEnabledById(actor, id, input.enabled);
    } else if ("config" in input)
      await this.facade.updateById(actor, id, input.config, { publicReadable: input.publicReadable });
    else {
      const row = await this.facade.getWritableById(actor, id);
      await this.facade.updateById(actor, id, row.config as McpServerConfig, { publicReadable: input.publicReadable });
    }
    return this.get(actor, id);
  }
  async remove(actor: ActorContext, id: string) {
    await this.facade.removeById(actor, id);
    return null;
  }
}
