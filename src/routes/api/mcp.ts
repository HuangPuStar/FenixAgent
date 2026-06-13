import Elysia from "elysia";
import { AppError } from "../../errors";
import { type AuthContext, authGuardPlugin } from "../../plugins/auth";
import * as configPg from "../../services/config/index";
import { countToolsByServer } from "../../services/config/mcp-server";

function mapApiError(err: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (err instanceof AppError) {
    return { status: err.statusCode, body: { error: { code: err.code, message: err.message } } };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Unknown error" } },
  };
}

const app = new Elysia({ name: "api-mcp", prefix: "/api/mcp" }).use(authGuardPlugin);

app.get(
  "/",
  async ({ store, error }: any) => {
    const authCtx = store.authContext as AuthContext | null;
    if (!authCtx) return error(401, { error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    try {
      const servers = await configPg.listMcpServers(authCtx);
      const serversWithCount = await Promise.all(
        servers.map(async (s: any) => {
          try {
            const tc = await countToolsByServer(s.organizationId, s.name);
            return {
              id: s.id,
              name: s.name,
              type: s.config?.type ?? "local",
              enabled: s.enabled ?? true,
              summary: String(s.config?.url ?? s.config?.command?.[0] ?? ""),
              toolsCount: tc,
              resourceAccess: s.resourceAccess,
            };
          } catch {
            return {
              id: s.id,
              name: s.name,
              type: s.config?.type ?? "local",
              enabled: s.enabled ?? true,
              summary: "",
              toolsCount: 0,
              resourceAccess: s.resourceAccess,
            };
          }
        }),
      );
      return { servers: serversWithCount };
    } catch (err: any) {
      const m = mapApiError(err);
      return error(m.status, m.body);
    }
  },
  { sessionAuth: true, detail: { tags: ["External MCP"], summary: "获取 MCP 列表" } },
);

app.get(
  "/:id",
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext | null;
    if (!authCtx) return error(401, { error: { code: "UNAUTHORIZED" } });
    try {
      const s = params.id.includes("/")
        ? await configPg.getMcpServerByResourceKey(authCtx, params.id)
        : await configPg.getMcpServer(authCtx, params.id);
      if (!s) return error(404, { error: { code: "NOT_FOUND" } });
      return {
        name: s.name,
        type: (s.config as any)?.type ?? "local",
        enabled: s.enabled ?? true,
        summary: String((s.config as any)?.url ?? (s.config as any)?.command?.[0] ?? ""),
        config: s.config,
        resourceAccess: s.resourceAccess,
      };
    } catch (err: any) {
      const m = mapApiError(err);
      return error(m.status, m.body);
    }
  },
  { sessionAuth: true, detail: { tags: ["External MCP"], summary: "获取 MCP" } },
);

app.post(
  "/",
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext as AuthContext | null;
    if (!authCtx) return error(401, { error: { code: "UNAUTHORIZED" } });
    try {
      const b = body as any;
      const config: any = { type: b.type ?? (b.url ? "remote" : "local") };
      if (b.command) config.command = b.command;
      if (b.url) config.url = b.url;
      if (b.headers) config.headers = b.headers;
      if (b.timeout) config.timeout = b.timeout;
      if (b.oauth) config.oauth = b.oauth;
      await configPg.createMcpServer(authCtx, b.name, config.type, config, { publicReadable: b.publicReadable });
      return { name: b.name };
    } catch (err: any) {
      const m = mapApiError(err);
      return error(m.status, m.body);
    }
  },
  { sessionAuth: true, detail: { tags: ["External MCP"], summary: "创建 MCP" } },
);

app.put(
  "/:id",
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext as AuthContext | null;
    if (!authCtx) return error(401, { error: { code: "UNAUTHORIZED" } });
    try {
      const b = body as any;
      const config: any = { type: b.type ?? (b.url ? "remote" : "local") };
      if (b.command !== undefined) config.command = b.command;
      if (b.url !== undefined) config.url = b.url;
      if (b.headers !== undefined) config.headers = b.headers;
      if (b.timeout !== undefined) config.timeout = b.timeout;
      if (b.oauth !== undefined) config.oauth = b.oauth;
      await configPg.updateMcpServer(authCtx, params.id, config, { publicReadable: b.publicReadable });
      return { name: params.id };
    } catch (err: any) {
      const m = mapApiError(err);
      return error(m.status, m.body);
    }
  },
  { sessionAuth: true, detail: { tags: ["External MCP"], summary: "修改 MCP" } },
);

app.delete(
  "/:id",
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext | null;
    if (!authCtx) return error(401, { error: { code: "UNAUTHORIZED" } });
    try {
      const deleted = await configPg.deleteMcpServer(authCtx, params.id);
      if (!deleted) return error(404, { error: { code: "NOT_FOUND" } });
      return { name: params.id, deleted: true };
    } catch (err: any) {
      const m = mapApiError(err);
      return error(m.status, m.body);
    }
  },
  { sessionAuth: true, detail: { tags: ["External MCP"], summary: "删除 MCP" } },
);

export default app;
