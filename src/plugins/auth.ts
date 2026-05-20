import Elysia from "elysia";
import { auth } from "../auth/better-auth";
import { decryptPassword, getEncryptionKey } from "../auth/encryption";
import { verifyWorkerJwt } from "../auth/jwt";
import { AppError } from "../errors";
import { config } from "../config";

// ────────────────────────────────────────────
// 测试注入：路由级测试通过 setTestAuth 绕过认证
// ────────────────────────────────────────────

let _testAuth: {
  user: UserInfo;
  session: AuthSessionInfo;
  authContext: AuthContext | null;
} | null = null;

export function setTestAuth(auth: { user: UserInfo; session?: AuthSessionInfo; authContext: AuthContext | null }) {
  _testAuth = {
    user: auth.user,
    session: auth.session ?? { id: "test-session", userId: auth.user.id, token: "test" },
    authContext: auth.authContext,
  };
}

export function resetTestAuth() {
  _testAuth = null;
}

interface UserInfo {
  id: string;
  email: string;
  name: string;
}

interface AuthSessionInfo {
  id: string;
  userId: string;
  token: string;
}

/** 统一认证上下文：替代散参数 userId */
export interface AuthContext {
  organizationId: string;
  userId: string;
  role: "owner" | "admin" | "member";
}

function extractToken(request: Request): string | undefined {
  const authHeader = request.headers.get("Authorization");
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  return authHeader?.replace("Bearer ", "") || queryToken || undefined;
}

export async function lookupUserById(userId: string): Promise<UserInfo | null> {
  const { db } = await import("../db");
  const { user } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const [row] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  return row ? { id: row.id, email: row.email, name: row.name } : null;
}

/** Mounts better-auth handler at /api/auth/* */
export const authPlugin = new Elysia({ name: "auth", prefix: "/api/auth" })
  /** 前端获取 AES 加密公钥 */
  .get("/encryption-key", () => ({ key: getEncryptionKey() }))
  /** 前端查询注册开关 */
  .get("/signup-status", () => ({ signupAllowed: !config.disableSignup }))
  .all("/*", async ({ request }) => {
    const url = new URL(request.url);
    const decryptRoutes = ["/sign-in/email", "/sign-up/email"];
    if (request.method === "POST" && decryptRoutes.some((r) => url.pathname.endsWith(r))) {
      try {
        const body: any = await request.clone().json();
        if (body?.password && typeof body.password === "string" && body.password.startsWith("AESGCM:")) {
          body.password = decryptPassword(body.password);
          return auth.handler(
            new Request(request.url, {
              method: request.method,
              headers: request.headers,
              body: JSON.stringify(body),
            }),
          );
        }
      } catch {
        // 解密失败，使用原始请求透传
      }
    }
    return auth.handler(request);
  });

/** Provides `error(code, body)` to route handler context */
export function errorResponse(code: number, response: unknown): Response {
  return new Response(JSON.stringify(response), {
    status: code,
    headers: { "Content-Type": "application/json" },
  });
}

/** Auth guard macros + state for route-level authentication */
export const authGuardPlugin = new Elysia({ name: "auth-guard" })
  .decorate({ error: errorResponse })
  .state({
    user: null as UserInfo | null,
    authSession: null as AuthSessionInfo | null,
    authEnvironmentId: null as string | null,
    uuid: null as string | null,
    authContext: null as AuthContext | null,
  })
  .onError(({ error, set }) => {
    if (error instanceof AppError) {
      set.status = error.statusCode;
      return { error: { type: error.code, message: error.message } };
    }
    // DrizzleQueryError wrapping PostgreSQL errors
    const msg = error instanceof Error ? (error.cause as any)?.message || error.message : "";
    // PostgreSQL invalid UUID format → treat as not found
    if (msg.includes("invalid input syntax for type uuid")) {
      set.status = 404;
      return { error: { type: "NOT_FOUND", message: "Resource not found" } };
    }
  })
  .macro({
    sessionAuth(enabled: boolean) {
      if (!enabled) return {};
      return {
        beforeHandle: async ({ store, request, error }: any) => {
          // 测试注入：直接设置 user 和 authContext，跳过 real auth
          if (_testAuth) {
            store.user = _testAuth.user;
            store.authSession = _testAuth.session;
            if (_testAuth.authContext) store.authContext = _testAuth.authContext;
            return;
          }
          const session = await auth.api.getSession({ headers: request.headers });
          if (!session?.user) {
            return error(401, { error: { type: "unauthorized", message: "Not authenticated" } });
          }
          store.user = { id: session.user.id, email: session.user.email, name: session.user.name };
          store.authSession = {
            id: session.session.id,
            userId: session.session.userId,
            token: session.session.token,
          };
          // 加载组织上下文
          const { loadOrgContext } = await import("../services/org-context");
          const ctx = await loadOrgContext(store.user, request);
          if (ctx) {
            store.authContext = ctx;
          }
        },
      };
    },
    apiKeyAuth(enabled: boolean) {
      if (!enabled) return {};
      return {
        beforeHandle: async ({ store, request, error }: any) => {
          const token = extractToken(request);
          if (!token) {
            return error(401, { error: { type: "unauthorized", message: "Missing API key" } });
          }

          // 0. Environment secret match
          const { environmentRepo } = await import("../repositories");
          const envRecord = await environmentRepo.getBySecret(token);
          if (envRecord && envRecord.userId) {
            const user = await lookupUserById(envRecord.userId);
            if (user) {
              store.user = user;
              store.authEnvironmentId = envRecord.id;
              const organizationId = envRecord.organizationId ?? envRecord.userId;
              const role = envRecord.organizationId && envRecord.organizationId !== envRecord.userId ? "member" : "owner";
              store.authContext = { organizationId, userId: user.id, role: role as "owner" | "admin" | "member" };
              return;
            }
          }

          // 1. better-auth API Key 验证
          const result = await auth.api.verifyApiKey({ key: token });
          if (result.valid && result.key) {
            const apiKeyMeta = result.key as any;
            const userId = apiKeyMeta.userId;
            const user = await lookupUserById(userId);
            if (user) {
              store.user = user;
              const orgId = apiKeyMeta.organizationId || apiKeyMeta.metadata?.organizationId;
              if (orgId) {
                store.authContext = {
                  organizationId: orgId,
                  userId: user.id,
                  role: (apiKeyMeta.metadata?.role as "owner" | "admin" | "member") || "owner",
                };
                return;
              }
              return error(403, { error: { type: "forbidden", message: "API key has no valid organization context" } });
            }
          }

          return error(401, { error: { type: "unauthorized", message: "Invalid API key" } });
        },
      };
    },
    uuidAuth(enabled: boolean) {
      if (!enabled) return {};
      return {
        beforeHandle: ({ store, request, error }: any) => {
          const url = new URL(request.url);
          const uuid = url.searchParams.get("uuid");
          if (!uuid) {
            return error(401, { error: { type: "unauthorized", message: "Missing uuid" } });
          }
          store.uuid = uuid;
        },
      };
    },
    sessionIngressAuth(enabled: boolean) {
      if (!enabled) return {};
      return {
        beforeHandle: async ({ store, request, error }: any) => {
          const token = extractToken(request);

          // Worker JWT
          if (token) {
            const payload = verifyWorkerJwt(token);
            if (payload) {
              return;
            }
          }

          return error(401, { error: { type: "unauthorized", message: "Invalid auth" } });
        },
      };
    },
  });
