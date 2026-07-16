import Elysia from "elysia";
import type { AuthContext } from "../plugins/auth";
import { authenticateRequest } from "../plugins/auth";
import type { Visibility } from "../repositories/agent-site-app";
import { agentSiteAppRepo } from "../repositories/agent-site-app";
import { isAgentSitesConfigured, proxyToAgentSites } from "../services/agent-sites";

/** 内存 LRU 缓存：remoteAppId → (visibility, organizationId, userId)，60s TTL */
const appCache = new Map<
  string,
  { row: { visibility: Visibility; organizationId: string; userId: string }; ts: number }
>();
const CACHE_TTL_MS = 60_000;

async function getAppByRemoteId(remoteAppId: string) {
  const cached = appCache.get(remoteAppId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.row;
  const row = await agentSiteAppRepo.getByRemoteAppId(remoteAppId);
  if (!row) return null;
  const slim: { visibility: Visibility; organizationId: string; userId: string } = {
    visibility: row.visibility as Visibility,
    organizationId: row.organizationId,
    userId: row.userId,
  };
  appCache.set(remoteAppId, { row: slim, ts: Date.now() });
  return slim;
}

/**
 * 使指定 app 的缓存失效。
 * 当 visibility 等字段被外部修改时调用，确保代理层下次请求走 DB 拉最新值。
 */
export function invalidateAppCache(remoteAppId: string): void {
  appCache.delete(remoteAppId);
}

/** 校验 app_id 格式：必须以 app- 开头 */
const APP_ID_RE = /^app-[a-z0-9]+$/;

/**
 * 按 visibility 检查访问权限。返回 null 表示允许访问，返回 Response 表示拒绝。
 */
function checkVisibility(
  slim: { visibility: Visibility; organizationId: string; userId: string },
  authCtx: AuthContext | null,
): Response | null {
  if (slim.visibility === "public") return null;
  if (!authCtx) {
    return new Response("", { status: 302 });
  }
  if (slim.visibility === "private" && authCtx.userId !== slim.userId) {
    return new Response("Forbidden — 此 app 仅创建者可访问", { status: 403 });
  }
  if (slim.visibility === "org" && authCtx.organizationId !== slim.organizationId) {
    return new Response("Forbidden — 此 app 仅组织内可访问", { status: 403 });
  }
  return null;
}

/**
 * 核心代理逻辑：校验 appId、检查 visibility 权限、转发到 agent-sites。
 * 返回 undefined 表示当前路由不处理（留给其他路由）。
 */
async function doProxy(
  appId: string,
  subPath: string,
  request: Request,
  set: { status: number; headers: Record<string, string> },
) {
  if (!APP_ID_RE.test(appId)) return;
  if (!isAgentSitesConfigured()) return;

  const slim = await getAppByRemoteId(appId);
  if (!slim) return;

  let authCtx: AuthContext | null = null;
  if (slim.visibility !== "public") {
    const authResult = await authenticateRequest(request);
    authCtx = authResult?.authContext ?? null;
  }
  const reject = checkVisibility(slim, authCtx);
  if (reject) {
    if (reject.status === 302) {
      set.status = 302;
      set.headers = {
        location: `/ctrl/login?redirect=${encodeURIComponent(new URL(request.url).pathname)}`,
      };
      return "";
    }
    if (reject.status === 403) {
      set.status = 302;
      set.headers = { location: "/ctrl/no-access" };
      return "";
    }
    set.status = reject.status;
    return reject.body;
  }
  return proxyToAgentSites(appId, subPath, request);
}

/**
 * 从 URL pathname 中提取 appId 和剩余路径。
 * 匹配 /app-xxxxxxxx 或 /app-xxxxxxxx/foo/bar
 */
function parseAppPath(pathname: string): { appId: string; subPath: string } | null {
  if (!pathname.startsWith("/app-")) return null;
  const appIdEnd = pathname.indexOf("/", 1);
  const appId = appIdEnd === -1 ? pathname.slice(1) : pathname.slice(1, appIdEnd);
  if (!APP_ID_RE.test(appId)) return null;
  const subPath = appIdEnd === -1 ? "/" : pathname.slice(appIdEnd);
  return { appId, subPath };
}

/** Agent Sites L3 业务前端代理，挂载在 /web/site/deploy 前缀下 */
export const agentSitesProxyApp = new Elysia({ name: "agent-sites-proxy", prefix: "/web/site/deploy" });

// /web/site/deploy/:appId（根路径，如 /web/site/deploy/app-abc123）
agentSitesProxyApp.all(
  "/:appId",
  ({ request, set, params }) => {
    return doProxy(params.appId, "/", request, set as { status: number; headers: Record<string, string> });
  },
  {
    detail: {
      hide: true,
      summary: "Agent Sites L3 业务前端代理（根路径）",
      description: "根据 appId 转发业务前端页面到 agent-sites 平台。",
    },
  },
);

// /web/site/deploy/:appId/*（子路径，如 /web/site/deploy/app-abc123/foo/bar）
agentSitesProxyApp.all(
  "/:appId/*",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 通配符 * 参数字段名为 '*'，类型系统无法表达
  ({ request, set, params }: any) => {
    const subPath = params["*"] ? `/${params["*"]}` : "/";
    return doProxy(params.appId, subPath, request, set as { status: number; headers: Record<string, string> });
  },
  {
    detail: {
      hide: true,
      summary: "Agent Sites L3 业务前端代理（子路径）",
      description: "代理 agent-sites 业务前端的子资源（JS/CSS/图片等）请求到 agent-sites 平台。",
    },
  },
);

/**
 * 兼容层：兜底根路径 /app-xxx/* 访问。
 * 部署站点内部使用绝对路径（如 /app-e1895c18/api/...）时，由本路由拦截并转发。
 * 必须注册在所有其他具体路由之后，作为最后兜底。非 /app- 前缀的路径直接 return 不做处理。
 */
export const agentSitesCompatApp = new Elysia({ name: "agent-sites-proxy-compat" });

agentSitesCompatApp.all(
  "/*",
  async ({ request, set }) => {
    const url = new URL(request.url);
    const parsed = parseAppPath(url.pathname);
    if (!parsed) return; // 非 app- 路径，留给 Elysia 最终 404
    return doProxy(parsed.appId, parsed.subPath, request, set as { status: number; headers: Record<string, string> });
  },
  {
    detail: {
      hide: true,
      summary: "Agent Sites 兼容层兜底代理（/app-xxx/*）",
      description: "兜底处理 /app-xxx 格式的旧路径访问，转发到 agent-sites 平台。仅注册在所有路由之后作为最后兜底。",
    },
  },
);
