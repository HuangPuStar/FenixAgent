import Elysia from "elysia";
import type { AuthContext } from "../plugins/auth";
import { authGuardPlugin } from "../plugins/auth";
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

const app = new Elysia({ name: "agent-sites-proxy" }).use(authGuardPlugin);

// 业务前端：/{appId} 和 /{appId}/* 统一用一个 ALL catch-all 处理
// 使用 * 通配符避免 memoirist 对 :param* 参数名的冲突
app.all("/*", async ({ request, store, set }) => {
  const url = new URL(request.url);
  const parsed = parseAppPath(url.pathname);
  if (!parsed) return; // 不是 agent-sites app，留给其他路由
  if (!isAgentSitesConfigured()) return;

  const slim = await getAppByRemoteId(parsed.appId);
  if (!slim) return; // 不在 RCS DB 中 → Elysia 继续匹配其他路由

  const authCtx: AuthContext | null = store.authContext ?? null;
  const reject = checkVisibility(slim, authCtx);
  if (reject) {
    if (reject.status === 302) {
      set.status = 302;
      set.headers = {
        location: `/login?redirect=${encodeURIComponent(new URL(request.url).pathname)}`,
      };
      return "";
    }
    set.status = reject.status;
    return reject.body;
  }
  return proxyToAgentSites(parsed.appId, parsed.subPath, request);
});

export default app;
