import Elysia from "elysia";
import { getAgentConfigModule } from "../runtime";
import { isAgentSitesConfigured, proxyToAgentSites } from "../services/agent-sites";
import type { AgentSitesProxyRouteDependencies, SiteRequestIdentity } from "./dependencies";

export { invalidatePublishTarget as invalidateAppCache } from "../services/agent-site-publish-cache";

/**
 * 站点发布面（对外访问）代理。
 *
 * ## 裁定：发布面的 `visibility` / 组织 / 用户由本文件解释（§3.3）
 *
 * - **谁解释**：发布面（本文件）解释"这个访客与站点发布范围的关系"。管理面的读范围与写权限不在这里：
 *   读口径由 `services/agent-site-app-service.ts` 作为业务条件下推，与平台授权谓词 AND 成同一条 SQL；
 *   写权限由 `facades/agent-site-app-facade.ts` 经 `AccessControlModule` 与组织角色判定（§3.2）。
 * - **依据**：§3.3 第一段末句「匿名访问由 Site 等资源专属发布字段或发布实体表达」。同段"资源领域、route、
 *   前端和普通 Repository 不得自行解释组织、用户、角色或 `visibility`"约束的是**资源受众与查询约束的
 *   下推**（`ResourceQueryConstraint`）：发布面没有 actor、也不产生受控查询，不落入该条射程。§10.3 第 2 条
 *   同理，它管的是"外部资源动作"——发布面访问不是资源动作。
 * - **为什么不是资源领域的授权判断**：这里回答"访客能否打开已部署的站点"（含未登录访客；发布范围以部署
 *   站点为单位、四值），而资源授权回答"当前主体能读/改哪些资源行"（`ResourceScope`，两值受众、以资源行为
 *   单位）。发布面既不读资源行（`PublishTarget` 只投影 `visibility` / `organizationId` / `userId`，不含
 *   `platform_token`），也不判定任何资源动作。
 * - **边界**：解释权不外溢——管理面的读写一律经 Facade；本文件新增分支时不得引入资源行查询或资源动作判定。
 *
 * 站点行由 Facade 的发布面入口按远端 app id 定位（含 60 秒读缓存），本文件只判定"这个访客是否落在
 * 发布范围内"并决定放行、重定向或拒绝。
 */

/** 发布面可见性判定的最小投影；由 Facade 的发布面入口产出。 */
interface PublishTarget {
  readonly visibility: string;
  readonly organizationId: string;
  readonly userId: string;
}

/** 校验 app_id 格式：必须以 app- 开头 */
const APP_ID_RE = /^app-[a-z0-9]+$/;

/**
 * 按发布范围检查访问权限。返回 null 表示允许访问，返回 Response 表示拒绝。
 *
 * 这是**发布语义判定**（文件头的裁定），不是资源授权判断：它只回答"访客是否在发布范围内"，不判定
 * 任何资源动作，也不接触资源行。
 *
 * 身份只用到用户与组织标识（见 `SiteRequestIdentity`），因此这里收的是投影而不是宿主认证对象。
 */
function checkVisibility(target: PublishTarget, identity: SiteRequestIdentity | null): Response | null {
  if (target.visibility === "public") return null;
  if (!identity) {
    return new Response("", { status: 302 });
  }
  if (target.visibility === "private" && identity.userId !== target.userId) {
    return new Response("Forbidden — 此 app 仅创建者可访问", { status: 403 });
  }
  if (target.visibility === "org" && identity.organizationId !== target.organizationId) {
    return new Response("Forbidden — 此 app 仅组织内可访问", { status: 403 });
  }
  return null;
}

/**
 * 核心代理逻辑：校验 appId、检查发布范围、转发到 agent-sites。
 * 返回 undefined 表示当前路由不处理（留给其他路由）。
 *
 * 认证走注入的 `authenticateRequest`（宿主的认证解析必须与 `/web` 守卫同一份实例，且这里要区分
 * 「未登录」与「已登录但无权限」并分别重定向，不能改用 `sessionAuth` 宏让守卫短路请求）。
 */
async function doProxy(
  deps: AgentSitesProxyRouteDependencies,
  appId: string,
  subPath: string,
  request: Request,
  set: { status: number; headers: Record<string, string> },
) {
  if (!APP_ID_RE.test(appId)) return;
  if (!isAgentSitesConfigured()) return;

  const target = await getAgentConfigModule().siteFacade.findPublishTarget(appId);
  if (!target) return;

  let identity: SiteRequestIdentity | null = null;
  if (target.visibility !== "public") {
    identity = await deps.authenticateRequest(request);
  }
  const reject = checkVisibility(target, identity);
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

/**
 * Agent Sites L3 业务前端代理，挂载在 /web/site/deploy 前缀下。
 *
 * 改为工厂（CE 阶段 2 任务 1.3）：认证实现由宿主注入，包侧不再 `import { authenticateRequest } from
 * "@server/plugins/auth"`。
 */
export function createAgentSitesProxyRoutes(deps: AgentSitesProxyRouteDependencies) {
  const app = new Elysia({ name: "agent-sites-proxy", prefix: "/web/site/deploy" });

  // /web/site/deploy/:appId（根路径，如 /web/site/deploy/app-abc123）
  app.all(
    "/:appId",
    ({ request, set, params }) => {
      return doProxy(deps, params.appId, "/", request, set as { status: number; headers: Record<string, string> });
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
  app.all(
    "/:appId/*",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 通配符 * 参数字段名为 '*'，类型系统无法表达
    ({ request, set, params }: any) => {
      const subPath = params["*"] ? `/${params["*"]}` : "/";
      return doProxy(deps, params.appId, subPath, request, set as { status: number; headers: Record<string, string> });
    },
    {
      detail: {
        hide: true,
        summary: "Agent Sites L3 业务前端代理（子路径）",
        description: "代理 agent-sites 业务前端的子资源（JS/CSS/图片等）请求到 agent-sites 平台。",
      },
    },
  );

  return app;
}

/**
 * 兼容层：兜底根路径 /app-xxx/* 访问。
 * 部署站点内部使用绝对路径（如 /app-e1895c18/api/...）时，由本路由拦截并转发。
 * 必须注册在所有其他具体路由之后，作为最后兜底。非 /app- 前缀的路径直接 return 不做处理。
 *
 * 与 {@link createAgentSitesProxyRoutes} 共用同一份依赖与发布面缓存：两者只是挂载点不同的同一条代理链路。
 */
export function createAgentSitesCompatRoutes(deps: AgentSitesProxyRouteDependencies) {
  const app = new Elysia({ name: "agent-sites-proxy-compat" });

  app.all(
    "/*",
    async ({ request, set }) => {
      const url = new URL(request.url);
      const parsed = parseAppPath(url.pathname);
      if (!parsed) return; // 非 app- 路径，留给 Elysia 最终 404
      return doProxy(
        deps,
        parsed.appId,
        parsed.subPath,
        request,
        set as { status: number; headers: Record<string, string> },
      );
    },
    {
      detail: {
        hide: true,
        summary: "Agent Sites 兼容层兜底代理（/app-xxx/*）",
        description: "兜底处理 /app-xxx 格式的旧路径访问，转发到 agent-sites 平台。仅注册在所有路由之后作为最后兜底。",
      },
    },
  );

  return app;
}
