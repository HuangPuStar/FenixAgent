import type { AuthContext } from "../plugins/auth";
import { getCache } from "./cache";

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
 * 解析 activeOrganizationId，通过 better-auth organization API 查角色，构建 AuthContext。
 */
export async function loadOrgContext(user: { id: string }, request: Request): Promise<AuthContext | null> {
  if (_testOrgContext) return _testOrgContext;

  // 先提取 activeOrgId，以便与缓存比对
  const activeOrgId = extractActiveOrgId(request);
  const cached = await orgCache.get<AuthContext>(user.id);
  if (cached && (!activeOrgId || cached.organizationId === activeOrgId)) return cached;

  try {
    const { auth } = await import("../auth/better-auth");
    // biome-ignore lint/suspicious/noExplicitAny: better-auth API return types don't match exactly
    const api = auth.api as any;
    if (activeOrgId) {
      const memberRes = await api.listMembers({
        query: { organizationId: activeOrgId },
        headers: request.headers,
      });
      // biome-ignore lint/suspicious/noExplicitAny: better-auth listMembers returns inconsistent shape
      const memberList: any[] = Array.isArray(memberRes) ? memberRes : ((memberRes as any)?.members ?? []);
      // biome-ignore lint/suspicious/noExplicitAny: better-auth member objects are untyped
      const me = memberList.find((m: any) => m.userId === user.id);
      if (me) {
        const result: AuthContext = {
          organizationId: activeOrgId,
          userId: user.id,
          role: me.role as "owner" | "admin" | "member",
        };
        await orgCache.set(user.id, result);
        return result;
      }
    }

    // fallback: 列出用户的组织，取第一个
    const orgs = await api.listOrganizations({ headers: request.headers });
    // biome-ignore lint/suspicious/noExplicitAny: better-auth listOrganizations return type is untyped
    const orgList: any[] = Array.isArray(orgs) ? orgs : [];
    if (orgList.length > 0) {
      const org = orgList[0];
      const memberRes = await api.listMembers({
        query: { organizationId: org.id },
        headers: request.headers,
      });
      // biome-ignore lint/suspicious/noExplicitAny: better-auth listMembers returns inconsistent shape
      const memberList: any[] = Array.isArray(memberRes) ? ((memberRes as any)?.members ?? []) : [];
      // biome-ignore lint/suspicious/noExplicitAny: better-auth member objects are untyped
      const me = memberList.find((m: any) => m.userId === user.id);
      if (me) {
        const result: AuthContext = {
          organizationId: org.id,
          userId: user.id,
          role: me.role as "owner" | "admin" | "member",
        };
        await orgCache.set(user.id, result);
        return result;
      }
    }

    // 无组织 → 返回 null（由上层处理首次组织创建）
  } catch (e: unknown) {
    console.error("[org-context] Failed to load:", e instanceof Error ? e.message : String(e));
  }
  return null;
}
