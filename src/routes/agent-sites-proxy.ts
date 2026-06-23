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

const app = new Elysia({ name: "agent-sites-proxy" }).use(authGuardPlugin);

// 业务前端：/{appId}（仅 app 首页，无子路径）
app.get("/:appId", async ({ params, request, store, set }) => {
  if (!APP_ID_RE.test(params.appId)) return;
  if (!isAgentSitesConfigured()) return;
  const slim = await getAppByRemoteId(params.appId);
  if (!slim) return;

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
  return proxyToAgentSites(params.appId, "/", request);
});

// 业务前端：/{appId}/*（子路径：静态文件 + PB API）
app.all("/:appId/:path*", async ({ params, request, store, set }) => {
  if (!APP_ID_RE.test(params.appId)) return;
  if (!isAgentSitesConfigured()) return;

  const slim = await getAppByRemoteId(params.appId);
  if (!slim) return;

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

  const subPath = `/${params.path ?? ""}`;
  return proxyToAgentSites(params.appId, subPath, request);
});

export default app;
