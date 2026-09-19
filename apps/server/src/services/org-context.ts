import { createLogger } from "@fenix/logger";
import type { OrganizationSummary } from "@fenix/platform-sdk";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import type { AuthContext } from "../plugins/auth";
import { getCache } from "./cache";

const log = createLogger("org-context");

// ────────────────────────────────────────────
// 测试注入：路由级测试通过 setTestOrgContext 绕过 DB 查询
// ────────────────────────────────────────────

let _testOrgContext: AuthContext | null = null;

export function setTestOrgContext(ctx: AuthContext | null) {
  _testOrgContext = ctx;
}

const ORG_CACHE_TTL_MS = 60_000; // 60 秒
const orgCache = getCache("org-context", ORG_CACHE_TTL_MS);

/** 测试用：清除缓存 */
export function clearOrgCache(): Promise<void> {
  return orgCache.clear();
}

/** 从请求中解析 activeOrganizationId（header > query param > cookie） */
function extractActiveOrgId(request: Request): string | null {
  const header = request.headers.get("x-active-org-id");
  if (header) return header;
  const url = new URL(request.url);
  const query = url.searchParams.get("activeOrganizationId");
  if (query) return query;
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)active_org_id=([^;]+)/)?.[1];
  if (cookie) return cookie;
  return null;
}

/**
 * 从 user + request 加载组织上下文。
 *
 * 落点说明（CE 阶段 2 任务 1.2）：本文件是**宿主适配层**，保留 `setTestOrgContext` 测试 seam 与
 * 60 秒进程内缓存；成员关系与组织名录改经 `IdentityDirectory` 读取，不再直连 better-auth
 * organization API，也不再把身份表查询留在宿主里。
 *
 * 成员关系以 `member.createdAt` 升序为准，因此"第一个组织"是确定性的：通常是注册时创建的
 * 个人组织。改动前该回退顺序由 better-auth `listOrganizations` 的返回顺序决定，未定义。
 */
export async function loadOrgContext(user: { id: string }, request: Request): Promise<AuthContext | null> {
  if (_testOrgContext) return _testOrgContext;

  // 先提取 activeOrgId，以便与缓存比对
  const activeOrgId = extractActiveOrgId(request);
  const cached = await orgCache.get<AuthContext>(user.id);
  if (cached && (!activeOrgId || cached.organizationId === activeOrgId)) return cached;

  try {
    const directory = getIdentityDirectory();
    const memberships = await directory.listMemberships(user.id);

    const requested = activeOrgId ? memberships.find((item) => item.organizationId === activeOrgId) : undefined;
    if (activeOrgId && !requested) {
      // activeOrgId 指定了但用户不是成员 → 记录差异后回退
      log.warn("active org not found in members, falling back to first org", {
        requestedOrgId: activeOrgId,
        userId: user.id,
      });
    }

    const resolved = requested ?? memberships[0];
    if (!resolved) {
      // 无组织 → 返回 null（由上层处理首次组织创建）
      return null;
    }

    // 组织名只是展示信息：名录读取失败不能让已经确定的成员关系整体失败（改动前该查询有独立
    // try/catch，迁移时若并入外层 try 会变成"名录故障 = 无组织上下文"的行为回归）。
    let organization: OrganizationSummary | undefined;
    try {
      organization = await directory.getOrganization(resolved.organizationId);
    } catch (nameError) {
      log.warn("Failed to load organization name for org context", {
        organizationId: resolved.organizationId,
        error: nameError instanceof Error ? nameError.message : String(nameError),
      });
    }
    if (!requested) {
      log.warn("org context resolved to first available organization", {
        organizationId: resolved.organizationId,
        organizationName: organization?.name,
        userId: user.id,
      });
    }

    const result: AuthContext = {
      organizationId: resolved.organizationId,
      organizationName: organization?.name,
      userId: user.id,
      role: resolved.role,
      // 全量成员关系：授权只在其中查"当前组织那一条"来定角色（组织资源的可见范围就是当前组织，
      // 其他组织的资源一律不可见），但身份投影必须完整——切组织后的角色、系统管理视图都以全量为
      // 前提，因此成员关系解析成功就必须整体带上，不能只带当前组织。
      memberships: memberships.map((membership) => ({
        organizationId: membership.organizationId,
        role: membership.role,
      })),
    };
    await orgCache.set(user.id, result);
    return result;
  } catch (e: unknown) {
    console.error("[org-context] Failed to load:", e instanceof Error ? e.message : String(e));
  }
  return null;
}
