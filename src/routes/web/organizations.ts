import { eq } from "drizzle-orm";
import Elysia from "elysia";
import { auth } from "../../auth/better-auth";
import { db } from "../../db";
import { member, user } from "../../db/schema";
import { authGuardPlugin } from "../../plugins/auth";

const app = new Elysia({ name: "web-organizations" }).use(authGuardPlugin);

// 窄化 better-auth API 类型，仅暴露本文件使用的方法
interface OrgApi {
  listOrganizations: (opts: { headers: Headers }) => Promise<unknown>;
  getFullOrganization: (opts: { query: { organizationId: string }; headers: Headers }) => Promise<unknown>;
  listMembers: (opts: { query: { organizationId: string }; headers: Headers }) => Promise<unknown>;
  createOrganization: (opts: {
    body: { name: string; slug: string; metadata?: Record<string, unknown> };
    headers: Headers;
  }) => Promise<unknown>;
  updateOrganization: (opts: {
    body: { data: Record<string, unknown>; organizationId: string };
    headers: Headers;
  }) => Promise<unknown>;
  deleteOrganization: (opts: { body: { organizationId: string }; headers: Headers }) => Promise<void>;
  setActiveOrganization: (opts: { body: { organizationId: string }; headers: Headers }) => Promise<void>;
  removeMember: (opts: {
    body: { memberIdOrEmail: string; organizationId?: string };
    headers: Headers;
  }) => Promise<void>;
  addMember: (opts: {
    body: { userId: string; role: string; organizationId: string };
    headers: Headers;
  }) => Promise<unknown>;
  updateMemberRole: (opts: {
    body: { memberId: string; organizationId?: string; role: string };
    headers: Headers;
  }) => Promise<void>;
  listApiKeys: (opts: { headers: Headers }) => Promise<unknown>;
  createApiKey: (opts: {
    body: { name: string; prefix: string; expiresIn: number | null; metadata: unknown };
    headers: Headers;
  }) => Promise<unknown>;
  deleteApiKey: (opts: { body: { id: string }; headers: Headers }) => Promise<void>;
  updateApiKey: (opts: { body: { id: string; name?: string }; headers: Headers }) => Promise<void>;
}

const api = auth.api as unknown as OrgApi;

function extractMembers(
  res: unknown,
): { id: string; userId: string; role: string; user?: { id: string; name: string; email: string } }[] {
  if (Array.isArray(res)) return res;
  if (res && typeof res === "object" && "members" in res)
    return (
      res as {
        members: Array<{
          id: string;
          userId: string;
          role: string;
          user?: { id: string; name: string; email: string };
        }>;
      }
    ).members;
  return [];
}

// ────────────────────────────────────────────
// Organization 管理（代理 better-auth organization 插件 API）
// ────────────────────────────────────────────

app.post(
  "/organizations",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + dynamic action body
  async ({ store, body, error, request }: any) => {
    const b = body ?? {};

    switch (b.action) {
      case "list": {
        const orgs = await api.listOrganizations({ headers: request.headers });
        if (!Array.isArray(orgs) || orgs.length === 0) {
          return { success: true, data: [] };
        }
        // better-auth listOrganizations 丢弃了 member.role，需要从 member 表补回
        const userId = store.user?.id;
        const memberships = await db
          .select({ organizationId: member.organizationId, role: member.role })
          .from(member)
          .where(eq(member.userId, userId))
          .execute();
        const roleMap = new Map(memberships.map((m) => [m.organizationId, m.role]));
        const enriched = orgs.map((o: Record<string, unknown>) => ({
          ...o,
          role: roleMap.get(o.id as string) ?? "member",
        }));
        return { success: true, data: enriched };
      }
      case "get": {
        if (!b.organizationId)
          return error(400, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: "organizationId required" },
          });
        const [org, members] = await Promise.all([
          api.getFullOrganization({ query: { organizationId: b.organizationId }, headers: request.headers }),
          api.listMembers({ query: { organizationId: b.organizationId }, headers: request.headers }),
        ]);
        const memberList = extractMembers(members);
        return { success: true, data: { ...(org as Record<string, unknown>), members: memberList } };
      }
      case "get-full": {
        const authCtx = store.authContext;
        if (!authCtx) return error(500, { success: false, error: { code: "NO_ORG_CONTEXT" } });
        const orgId = b.organizationId ?? authCtx.organizationId;
        const [org, members] = await Promise.all([
          api.getFullOrganization({ query: { organizationId: orgId }, headers: request.headers }),
          api.listMembers({ query: { organizationId: orgId }, headers: request.headers }),
        ]);
        const memberList = extractMembers(members);
        return { success: true, data: { ...(org as Record<string, unknown>), members: memberList } };
      }
      case "create": {
        if (!b.name || !b.slug)
          return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "name and slug required" } });
        try {
          const org = await api.createOrganization({
            body: {
              name: b.name,
              slug: b.slug,
              metadata: b.description ? { description: b.description } : undefined,
            },
            headers: request.headers,
          });
          return { success: true, data: org };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "";
          if (msg.includes("unique") || msg.includes("duplicate")) {
            return error(409, { success: false, error: { code: "ALREADY_EXISTS", message: "slug 已被使用" } });
          }
          throw err;
        }
      }
      case "update": {
        if (!b.organizationId || !b.data)
          return error(400, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: "organizationId and data required" },
          });
        const org = await api.updateOrganization({
          body: { data: b.data, organizationId: b.organizationId },
          headers: request.headers,
        });
        return { success: true, data: org };
      }
      case "delete": {
        if (!b.organizationId)
          return error(400, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: "organizationId required" },
          });
        await api.deleteOrganization({ body: { organizationId: b.organizationId }, headers: request.headers });
        return { success: true, data: { deleted: true } };
      }
      case "set-active": {
        if (!b.organizationId)
          return error(400, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: "organizationId required" },
          });
        await api.setActiveOrganization({ body: { organizationId: b.organizationId }, headers: request.headers });
        return { success: true };
      }
      case "list-members": {
        if (!b.organizationId)
          return error(400, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: "organizationId required" },
          });
        const members = await api.listMembers({
          query: { organizationId: b.organizationId },
          headers: request.headers,
        });
        const memberData = extractMembers(members);
        return { success: true, data: memberData };
      }
      case "add-member": {
        if (!b.organizationId || !b.role)
          return error(400, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: "organizationId, role required" },
          });
        // 支持 userId（直接传或传邮箱自动转换）
        let memberUserId: string | undefined;
        const rawId = (b.userId ?? b.email) as string | undefined;
        if (!rawId) {
          return error(400, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: "userId or email required" },
          });
        }
        if (rawId.includes("@")) {
          // 传入的是邮箱，查找对应 userId
          const [foundUser] = await db.select({ id: user.id }).from(user).where(eq(user.email, rawId)).limit(1);
          if (!foundUser)
            return error(404, { success: false, error: { code: "USER_NOT_FOUND", message: "该邮箱用户不存在" } });
          memberUserId = foundUser.id;
        } else {
          memberUserId = rawId;
        }
        const result = await api.addMember({
          body: { userId: memberUserId, role: b.role, organizationId: b.organizationId },
          headers: request.headers,
        });
        return { success: true, data: result };
      }
      case "remove-member": {
        if (!b.organizationId || !b.memberId)
          return error(400, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: "organizationId, memberId required" },
          });
        await api.removeMember({
          body: { memberIdOrEmail: b.memberId, organizationId: b.organizationId },
          headers: request.headers,
        });
        return { success: true };
      }
      case "update-role": {
        if (!b.organizationId || !b.memberId || !b.role)
          return error(400, {
            success: false,
            error: { code: "VALIDATION_ERROR", message: "organizationId, memberId, role required" },
          });
        await api.updateMemberRole({
          body: { memberId: b.memberId, organizationId: b.organizationId, role: b.role },
          headers: request.headers,
        });
        return { success: true };
      }
      default:
        return error(400, {
          success: false,
          error: { code: "VALIDATION_ERROR", message: `Unknown action: ${b.action}` },
        });
    }
  },
  { sessionAuth: true },
);

// ────────────────────────────────────────────
// API Key 管理（代理 better-auth apiKey 插件 API）
// ────────────────────────────────────────────

app.post(
  "/apiKeys",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + dynamic action body
  async ({ store: _store, body, error, request }: any) => {
    const b = body ?? {};

    switch (b.action) {
      case "list": {
        const result = (await api.listApiKeys({ headers: request.headers })) as {
          apiKeys?: unknown[];
        } | null;
        const keys = Array.isArray(result?.apiKeys) ? result.apiKeys : Array.isArray(result) ? result : [];
        return { success: true, data: keys };
      }
      case "create": {
        if (!b.name)
          return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "name required" } });
        const result = await api.createApiKey({
          body: {
            name: b.name,
            prefix: "rcs_",
            expiresIn: b.expiresAt ? Math.ceil((new Date(b.expiresAt).getTime() - Date.now()) / 1000) : null,
            metadata: b.metadata ?? null,
          },
          headers: request.headers,
        });
        return { success: true, data: result };
      }
      case "delete": {
        if (!b.id) return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "id required" } });
        await api.deleteApiKey({ body: { id: b.id }, headers: request.headers });
        return { success: true, data: { deleted: true } };
      }
      case "update": {
        if (!b.id) return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "id required" } });
        await api.updateApiKey({ body: { id: b.id, name: b.name }, headers: request.headers });
        return { success: true };
      }
      default:
        return error(400, {
          success: false,
          error: { code: "VALIDATION_ERROR", message: `Unknown action: ${b.action}` },
        });
    }
  },
  { sessionAuth: true },
);

export default app;
