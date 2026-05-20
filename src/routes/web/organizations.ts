import Elysia from "elysia";
import { auth } from "../../auth/better-auth";
import { authGuardPlugin } from "../../plugins/auth";

const app = new Elysia({ name: "web-organizations", prefix: "/web" }).use(authGuardPlugin);

// ────────────────────────────────────────────
// Organization 管理（代理 better-auth organization 插件 API）
// ────────────────────────────────────────────

app.post("/organizations", async ({ store, body, error, request }: any) => {
  const b = body ?? {};
  const user = store.user!;

  switch (b.action) {
    case "list": {
      const orgs = await auth.api.listOrganizations({ headers: request.headers });
      return { success: true, data: Array.isArray(orgs) ? orgs : [] };
    }
    case "get": {
      if (!b.organizationId) return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "organizationId required" } });
      const [org, members] = await Promise.all([
        auth.api.getOrganization({ query: { organizationId: b.organizationId } }),
        auth.api.listMembers({ query: { organizationId: b.organizationId } }),
      ]);
      return { success: true, data: { ...org, members: Array.isArray(members) ? members : [] } };
    }
    case "get-full": {
      const authCtx = store.authContext;
      if (!authCtx) return error(500, { success: false, error: { code: "NO_ORG_CONTEXT" } });
      const orgId = b.organizationId ?? authCtx.organizationId;
      const [org, members] = await Promise.all([
        auth.api.getOrganization({ query: { organizationId: orgId } }),
        auth.api.listMembers({ query: { organizationId: orgId } }),
      ]);
      return { success: true, data: { ...org, members: Array.isArray(members) ? members : [] } };
    }
    case "create": {
      if (!b.name || !b.slug)
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "name and slug required" } });
      try {
        const org = await auth.api.createOrganization(
          { name: b.name, slug: b.slug, metadata: b.description ?? null },
          { headers: request.headers },
        );
        return { success: true, data: org };
      } catch (err: any) {
        const msg = err.message || "";
        if (msg.includes("unique") || msg.includes("duplicate")) {
          return error(409, { success: false, error: { code: "ALREADY_EXISTS", message: "slug 已被使用" } });
        }
        throw err;
      }
    }
    case "update": {
      if (!b.organizationId || !b.data)
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "organizationId and data required" } });
      const org = await auth.api.updateOrganization(
        { data: b.data, organizationId: b.organizationId },
        { headers: request.headers },
      );
      return { success: true, data: org };
    }
    case "delete": {
      if (!b.organizationId)
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "organizationId required" } });
      await auth.api.deleteOrganization({ organizationId: b.organizationId }, { headers: request.headers });
      return { success: true, data: { deleted: true } };
    }
    case "set-active": {
      if (!b.organizationId)
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "organizationId required" } });
      await auth.api.setActiveOrganization({ organizationId: b.organizationId }, { headers: request.headers });
      return { success: true };
    }
    case "list-members": {
      if (!b.organizationId)
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "organizationId required" } });
      const members = await auth.api.listMembers({ query: { organizationId: b.organizationId } });
      return { success: true, data: Array.isArray(members) ? members : [] };
    }
    case "add-member": {
      if (!b.organizationId || !b.email || !b.role)
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "organizationId, email, role required" } });
      const invitation = await auth.api.createInvitation(
        { email: b.email, role: b.role, organizationId: b.organizationId },
        { headers: request.headers },
      );
      return { success: true, data: invitation };
    }
    case "remove-member": {
      if (!b.organizationId || !b.userId)
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "organizationId, userId required" } });
      await auth.api.removeMember({ organizationId: b.organizationId, userId: b.userId }, { headers: request.headers });
      return { success: true };
    }
    case "update-role": {
      if (!b.organizationId || !b.userId || !b.role)
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "organizationId, userId, role required" } });
      await auth.api.updateMemberRole(
        { organizationId: b.organizationId, userId: b.userId, role: b.role },
        { headers: request.headers },
      );
      return { success: true };
    }
    default:
      return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: `Unknown action: ${b.action}` } });
  }
}, { sessionAuth: true });

// ────────────────────────────────────────────
// API Key 管理（代理 better-auth apiKey 插件 API）
// ────────────────────────────────────────────

app.post("/apiKeys", async ({ store, body, error, request }: any) => {
  const b = body ?? {};
  const user = store.user!;

  switch (b.action) {
    case "list": {
      const keys = await auth.api.listApiKeys({ headers: request.headers });
      return { success: true, data: Array.isArray(keys) ? keys : [] };
    }
    case "create": {
      if (!b.name)
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "name required" } });
      const result = await auth.api.createApiKey(
        { name: b.name, prefix: "rcs_", expiresAt: b.expiresAt ?? null, metadata: b.metadata ?? null },
        { headers: request.headers },
      );
      return { success: true, data: result };
    }
    case "delete": {
      if (!b.id)
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "id required" } });
      await auth.api.deleteApiKey({ id: b.id }, { headers: request.headers });
      return { success: true, data: { deleted: true } };
    }
    case "update": {
      if (!b.id)
        return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: "id required" } });
      await auth.api.updateApiKey({ id: b.id, name: b.name }, { headers: request.headers });
      return { success: true };
    }
    default:
      return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: `Unknown action: ${b.action}` } });
  }
}, { sessionAuth: true });

export default app;
