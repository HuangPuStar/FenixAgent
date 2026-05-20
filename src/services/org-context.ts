import type { AuthContext } from "../plugins/auth";

// ────────────────────────────────────────────
// 测试注入：路由级测试通过 setTestOrgContext 绕过 DB 查询
// ────────────────────────────────────────────

let _testOrgContext: AuthContext | null = null;

export function setTestOrgContext(ctx: AuthContext | null) {
  _testOrgContext = ctx;
}

/** 从请求中解析 activeOrganizationId（header > query param > cookie） */
function extractActiveOrgId(request: Request): string | null {
  const header = request.headers.get("x-active-org-id");
  if (header) return header;
  // EventSource 无法发送自定义 header，通过 query param 传递
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
 * 无组织时自动创建个人组织。
 */
export async function loadOrgContext(user: { id: string }, request: Request): Promise<AuthContext | null> {
  if (_testOrgContext) return _testOrgContext;
  try {
    const { auth } = await import("../auth/better-auth");

    const activeOrgId = extractActiveOrgId(request);
    if (activeOrgId) {
      // 通过 better-auth API 检查用户是否为该组织成员并获取角色
      const members = await auth.api.listMembers({
        query: { organizationId: activeOrgId },
      });
      const memberList = Array.isArray(members) ? members : [];
      const me = memberList.find((m: any) => m.userId === user.id);
      if (me) {
        return {
          organizationId: activeOrgId,
          userId: user.id,
          role: (me as any).role as "owner" | "admin" | "member",
        };
      }
    }

    // fallback: 列出用户的组织，取第一个
    const orgs = await auth.api.listOrganizations({
      headers: request.headers,
    });
    const orgList = Array.isArray(orgs) ? orgs : [];
    if (orgList.length > 0) {
      const org = orgList[0];
      const members = await auth.api.listMembers({
        query: { organizationId: (org as any).id },
      });
      const memberList = Array.isArray(members) ? members : [];
      const me = memberList.find((m: any) => m.userId === user.id);
      if (me) {
        return {
          organizationId: (org as any).id,
          userId: user.id,
          role: (me as any).role as "owner" | "admin" | "member",
        };
      }
    }

    // 无组织 → 自动创建个人组织
    const personalOrg = await auth.api.createOrganization(
      {
        name: `Personal`,
        slug: `personal-${user.id.slice(0, 8)}`,
      },
      {
        headers: request.headers,
      },
    );
    if (personalOrg) {
      return {
        organizationId: (personalOrg as any).id,
        userId: user.id,
        role: "owner",
      };
    }
  } catch (e: any) {
    console.error("[org-context] Failed to load:", e.message);
  }
  return null;
}
