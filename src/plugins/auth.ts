import { requestAls } from "@fenix/logger";
import Elysia from "elysia";
import { auth } from "../auth/better-auth";
import { decryptPassword, getEncryptionKey } from "../auth/encryption";
import { verifyWorkerJwt } from "../auth/jwt";
import { config } from "../config";
import { AppError } from "../errors";

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
  organizationName?: string;
  userId: string;
  role: "owner" | "admin" | "member";
}

function extractToken(request: Request): string | undefined {
  const authHeader = request.headers.get("Authorization");
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  return authHeader?.replace("Bearer ", "") || queryToken || undefined;
}

/**
 * 认证成功后，将用户/组织信息注入 ALS 上下文。
 * 相当于 Java Spring Security 认证成功后的 MDC.put("username", auth.getName())。
 * logger.info() 等调用会自动从 ALS 读取这些字段，无需手动传参。
 */
function enrichAlsContext(user: UserInfo, authContext: AuthContext | null): void {
  const store = requestAls.getStore();
  if (!store) return;
  store.userId = user.id;
  store.username = user.name;
  if (authContext) {
    store.organizationId = authContext.organizationId;
    store.organizationName = authContext.organizationName;
  }
}

/** 尝试通过 API key / environment secret 认证，成功返回 true 并设置 store */
async function tryApiKeyAuth(
  store: { user: UserInfo | null; authEnvironmentId: string | null; authContext: AuthContext | null },
  request: Request,
): Promise<boolean> {
  const token = extractToken(request);
  if (!token) return false;

  // 0. Environment secret match
  const { environmentRepo } = await import("../repositories");
  const envRecord = await environmentRepo.getBySecret(token);
  if (envRecord?.userId) {
    const user = await lookupUserById(envRecord.userId);
    if (user) {
      store.user = user;
      store.authEnvironmentId = envRecord.id;
      const organizationId = envRecord.organizationId ?? envRecord.userId;
      const role = envRecord.organizationId && envRecord.organizationId !== envRecord.userId ? "member" : "owner";
      store.authContext = { organizationId, userId: user.id, role: role as "owner" | "admin" | "member" };
      return true;
    }
  }

  // 1. better-auth API Key 验证
  // biome-ignore lint/suspicious/noExplicitAny: better-auth verifyApiKey return type is untyped
  const result: any = await auth.api.verifyApiKey({ body: { key: token } });
  if (result.valid && result.key) {
    // biome-ignore lint/suspicious/noExplicitAny: better-auth API key metadata shape is untyped
    const apiKeyMeta = result.key as any;
    // better-auth API key 统一以 referenceId 表示归属主体；当前配置下它就是创建该 key 的用户 ID。
    // 注意：API key 字符串本身不携带组织信息，这里必须依赖 apikey 记录中的 metadata
    // 来恢复 organizationId / role，才能让纯 Bearer key 请求通过后续的多租户权限校验。
    const userId = apiKeyMeta.referenceId;
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
        return true;
      }
    }
  }

  return false;
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
  .get("/encryption-key", () => ({ key: getEncryptionKey() }), {
    detail: {
      tags: ["Auth"],
      summary: "获取登录加密公钥",
      description: "前端登录或注册前调用，获取用于密码 AES-GCM 加密的公钥材料。",
    },
  })
  /** 前端查询注册开关 */
  .get("/signup-status", () => ({ signupAllowed: !config.disableSignup }), {
    detail: {
      tags: ["Auth"],
      summary: "获取注册开关状态",
      description: "前端登录页调用，判断当前系统是否允许新用户注册。",
    },
  })
  .all(
    "/*",
    async ({ request }) => {
      const url = new URL(request.url);
      const decryptRoutes = ["/sign-in/email", "/sign-up/email", "/change-password"];
      if (request.method === "POST" && decryptRoutes.some((r) => url.pathname.endsWith(r))) {
        try {
          // biome-ignore lint/suspicious/noExplicitAny: request body parsed dynamically
          const body: any = await request.clone().json();
          let decrypted = false;
          if (body?.password && typeof body.password === "string" && body.password.startsWith("AESGCM:")) {
            body.password = decryptPassword(body.password);
            decrypted = true;
          }
          if (
            body?.currentPassword &&
            typeof body.currentPassword === "string" &&
            body.currentPassword.startsWith("AESGCM:")
          ) {
            body.currentPassword = decryptPassword(body.currentPassword);
            decrypted = true;
          }
          if (body?.newPassword && typeof body.newPassword === "string" && body.newPassword.startsWith("AESGCM:")) {
            body.newPassword = decryptPassword(body.newPassword);
            decrypted = true;
          }
          if (decrypted) {
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
    },
    {
      detail: {
        hide: true,
        tags: ["Auth"],
        summary: "better-auth 认证框架入口",
        description:
          "better-auth 的通用认证入口，承接登录、注册、会话、组织等框架级认证请求。该入口主要服务于认证框架内部流程，默认不在公开文档中展示。",
      },
    },
  );

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
    const msg = error instanceof Error ? (error.cause as { message?: string })?.message || error.message : "";
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
        // biome-ignore lint/suspicious/noExplicitAny: Elysia macro context type not fully expressible
        beforeHandle: async ({ store, request, error }: any) => {
          // 测试注入：直接设置 user 和 authContext，跳过 real auth
          if (_testAuth) {
            store.user = _testAuth.user;
            store.authSession = _testAuth.session;
            // 测试注入需要显式覆盖为空，避免前一次请求残留的组织上下文污染当前断言。
            store.authContext = _testAuth.authContext;
            enrichAlsContext(_testAuth.user, _testAuth.authContext);
            return;
          }
          const session = await auth.api.getSession({ headers: request.headers });
          if (session?.user) {
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
            enrichAlsContext(store.user, store.authContext);
            return;
          }
          // Cookie 认证失败，fallback 到 API key / environment secret
          const apiKeyOk = await tryApiKeyAuth(store, request);
          if (!apiKeyOk) {
            return error(401, { error: { type: "unauthorized", message: "Not authenticated" } });
          }
          // API key 认证成功，store 中已有 user 和 authContext
          if (store.user) {
            enrichAlsContext(store.user, store.authContext);
          }
        },
      };
    },
    apiKeyAuth(enabled: boolean) {
      if (!enabled) return {};
      return {
        // biome-ignore lint/suspicious/noExplicitAny: Elysia macro context type not fully expressible
        beforeHandle: async ({ store, request, error }: any) => {
          const ok = await tryApiKeyAuth(store, request);
          if (!ok) {
            return error(401, { error: { type: "unauthorized", message: "Invalid API key" } });
          }
          if (store.user) {
            enrichAlsContext(store.user, store.authContext);
          }
        },
      };
    },
    uuidAuth(enabled: boolean) {
      if (!enabled) return {};
      return {
        // biome-ignore lint/suspicious/noExplicitAny: Elysia macro context type not fully expressible
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
        // biome-ignore lint/suspicious/noExplicitAny: Elysia macro context type not fully expressible
        beforeHandle: async ({ store: _store, request, error }: any) => {
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
