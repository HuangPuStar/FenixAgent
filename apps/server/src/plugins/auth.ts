// 只经 `./server/environment` 窄入口取仓储：`@fenix/agent-runtime/server` barrel 会静态引入
// `launch-spec-builder`，后者又引入 `@fenix/resource-knowledge/server`（含路由模块），而 knowledge
// 路由反向依赖 `@server/plugins/auth` —— 形成 `auth → agent-runtime → knowledge 路由 → auth` 的
// 顶层 TDZ 环（`source-route-imports.test.ts` 用全新进程守护这一点）。窄入口只暴露 environment 仓储。
import { environmentRepo } from "@fenix/agent-runtime/server/environment";
import {
  buildPhoneTempEmail,
  decryptPassword,
  type EnvironmentSecretResolver,
  getAuth,
  getEncryptionKey,
  IdentityAuthenticationError,
  isPhoneNumberRegistered,
  normalizeChineseMainlandPhoneNumber,
  resolveCredentialAuthentication,
  resolveIdentityAuthentication,
} from "@fenix/identity/server";
import { requestAls } from "@fenix/logger";
import { type ActorContext, AppError } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { config } from "../config";

/**
 * 宿主的认证适配层（CE 阶段 2 任务 1.2）。
 *
 * 凭据解析（session cookie → Environment Secret → API Key）的唯一实现已迁到
 * `@fenix/identity`（`services/request-authentication`）。本文件只保留三件宿主才有权做的事：
 *
 * 1. **测试 seam**（`setTestAuth` / `resetTestAuth`）：短路认证，供路由级测试注入上下文。identity
 *    是纯库，不能持有进程级可变测试状态，否则同进程内两次装配会共享它。
 * 2. **ALS 上下文与 `store` 写入**：日志字段（userId / organizationId / role）属于宿主可观测性契约。
 * 3. **active organization 解析**（`services/org-context`，含 60 秒进程内缓存）：identity 返回的
 *    session 结果不含组织上下文，宿主用请求头/cookie 补齐并缓存。
 *
 * 错误映射：identity 抛 `IdentityAuthenticationError`（携带 HTTP 状态与稳定错误码），这里转成
 * 平台契约的 `AppError`（`@fenix/platform-sdk`），使 429 / `RATE_LIMITED` 的对外行为与迁移前完全一致。
 */

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

export interface RequestAuthResult {
  user: UserInfo;
  authSession: AuthSessionInfo | null;
  authEnvironmentId: string | null;
  authContext: AuthContext | null;
}

/** 统一认证上下文：替代散参数 userId */
export interface AuthContext {
  organizationId: string;
  organizationName?: string;
  userId: string;
  role: "owner" | "admin" | "member";
  /**
   * 用户的**全量**组织成员关系，不只当前 active organization。
   *
   * 授权只使用其中的**当前组织**那一条（组织资源的可见范围就是 active organization），全量的
   * 意义是身份投影完整：切组织后的角色、系统管理视图等都以全量成员关系为前提。生产路径由
   * `services/org-context` 从 `IdentityDirectory` 填充。测试构造的上下文可以省略，此时
   * {@link toActorContext} 回退为「当前组织 + 当前角色」。
   */
  memberships?: readonly { readonly organizationId: string; readonly role: "owner" | "admin" | "member" }[];
}

/**
 * 把宿主的请求级身份投影为平台可信主体（`ActorContext`）。
 *
 * 这是宿主唯一的主体转换点：资源包与平台实现都只消费 `ActorContext`，不得自行解释
 * `AuthContext.role` 或成员关系。`super-admin` 不在此赋值（决策 D8：当前没有任何生产赋值点，
 * 契约分支保留给系统管理形态确定后的扩展）。
 *
 * `memberships` 缺失时回退为「当前组织 + 当前角色」：只有无法解析全量成员关系的上下文（测试
 * 构造的 `setTestAuth` / `setTestOrgContext`）才会走到该分支，生产路径始终带全量成员关系。
 */
export function toActorContext(ctx: AuthContext): ActorContext {
  return {
    kind: "user",
    userId: ctx.userId,
    activeOrganizationId: ctx.organizationId,
    memberships: ctx.memberships ?? [{ organizationId: ctx.organizationId, role: ctx.role }],
  };
}

/**
 * Environment Secret 的存储属于 agent-runtime（`environment` 表），而 `@fenix/identity` 属
 * `platform-impl`，不得依赖 agent-runtime。凭据**顺序**是身份规则、留在 identity，
 * 「按密钥查 environment」这一步由宿主实现后注入。
 *
 * 未命中或 `userId` 为空时返回 null：与迁移前 `if (envRecord?.userId)` 的判定一致。
 */
const resolveEnvironmentSecret: EnvironmentSecretResolver = async (secret) => {
  const record = await environmentRepo.getBySecret(secret);
  if (!record?.userId) return null;
  return {
    environmentId: record.id,
    userId: record.userId,
    organizationId: record.organizationId ?? null,
  };
};

/** 把 identity 的认证失败映射回宿主错误类，保持对外状态码与错误码不变。 */
function toAppError(error: unknown): never {
  if (error instanceof IdentityAuthenticationError) {
    throw new AppError(error.message, error.code, error.statusCode);
  }
  throw error;
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
    store.role = authContext.role;
  }
}

/**
 * 统一解析 HTTP / WebSocket 升级请求的认证结果。
 * 优先尝试 session cookie，失败后再 fallback 到 environment secret / API key。
 */
export async function authenticateRequest(request: Request): Promise<RequestAuthResult | null> {
  if (_testAuth) {
    return {
      user: _testAuth.user,
      authSession: _testAuth.session,
      authEnvironmentId: null,
      authContext: _testAuth.authContext,
    };
  }

  const result = await resolveIdentityAuthentication(request, { resolveEnvironmentSecret }).catch(toAppError);
  if (!result) return null;

  // session 路径的组织上下文由宿主解析 active organization；凭据路径自带组织上下文。
  const authContext = result.authSession
    ? await (await import("../services/org-context")).loadOrgContext(result.user, request)
    : result.credentialOrganization;

  return {
    user: result.user,
    authSession: result.authSession,
    authEnvironmentId: result.authEnvironmentId,
    authContext,
  };
}

/** 仅凭据路径（Environment Secret / API Key）的认证尝试，成功时写入 store。 */
async function tryApiKeyAuth(
  store: {
    user: UserInfo | null;
    authEnvironmentId: string | null;
    authContext: AuthContext | null;
    actor: ActorContext | null;
  },
  request: Request,
): Promise<boolean> {
  const result = await resolveCredentialAuthentication(request, { resolveEnvironmentSecret }).catch(toAppError);
  if (!result) return false;

  store.user = result.user;
  store.authEnvironmentId = result.authEnvironmentId;
  store.authContext = result.credentialOrganization;
  store.actor = result.credentialOrganization ? toActorContext(result.credentialOrganization) : null;
  return true;
}

function decryptSensitiveFields(body: Record<string, unknown>): { body: Record<string, unknown>; decrypted: boolean } {
  let decrypted = false;
  if (typeof body.password === "string" && body.password.startsWith("AESGCM:")) {
    body.password = decryptPassword(body.password);
    decrypted = true;
  }
  if (typeof body.currentPassword === "string" && body.currentPassword.startsWith("AESGCM:")) {
    body.currentPassword = decryptPassword(body.currentPassword);
    decrypted = true;
  }
  if (typeof body.newPassword === "string" && body.newPassword.startsWith("AESGCM:")) {
    body.newPassword = decryptPassword(body.newPassword);
    decrypted = true;
  }
  return { body, decrypted };
}

function normalizePhoneFields(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.phoneNumber === "string") {
    body.phoneNumber = normalizeChineseMainlandPhoneNumber(body.phoneNumber);
  }
  return body;
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
  .post(
    "/sign-up/phone",
    async ({ request, set }) => {
      const rawBody = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!rawBody) {
        set.status = 400;
        return { code: "INVALID_REQUEST", message: "请求体格式不正确" };
      }

      const { body } = decryptSensitiveFields(rawBody);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const rawPhoneNumber = typeof body.phoneNumber === "string" ? body.phoneNumber : "";

      if (!name || !password || !rawPhoneNumber) {
        set.status = 400;
        return { code: "VALIDATION_ERROR", message: "name、phoneNumber、password 为必填项" };
      }

      let phoneNumber = "";
      try {
        phoneNumber = normalizeChineseMainlandPhoneNumber(rawPhoneNumber);
      } catch (error) {
        set.status = 400;
        return {
          code: "INVALID_PHONE_NUMBER",
          message: error instanceof Error ? error.message : "手机号格式不正确",
        };
      }

      if (await isPhoneNumberRegistered(phoneNumber)) {
        set.status = 422;
        return { code: "PHONE_NUMBER_EXISTS", message: "该手机号已注册" };
      }

      return getAuth().handler(
        new Request(new URL("/api/auth/sign-up/email", request.url).toString(), {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify({
            name,
            password,
            phoneNumber,
            email: buildPhoneTempEmail(phoneNumber),
          }),
        }),
      );
    },
    {
      detail: {
        hide: true,
        tags: ["Auth"],
        summary: "手机号注册",
        description: "兼容 better-auth 邮箱注册链路的手机号注册入口，会自动为手机号用户生成临时邮箱。",
      },
    },
  )
  .all(
    "/*",
    async ({ request }) => {
      const url = new URL(request.url);
      const decryptRoutes = ["/sign-in/email", "/sign-up/email", "/sign-in/phone-number", "/change-password"];
      if (request.method === "POST" && decryptRoutes.some((r) => url.pathname.endsWith(r))) {
        try {
          const parsed = (await request.clone().json()) as Record<string, unknown>;
          const { body, decrypted } = decryptSensitiveFields(parsed);
          normalizePhoneFields(body);
          if (decrypted || typeof body.phoneNumber === "string") {
            return getAuth().handler(
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
      return getAuth().handler(request);
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
    actor: null as ActorContext | null,
  })
  .macro({
    sessionAuth(enabled: boolean) {
      if (!enabled) return {};
      return {
        // biome-ignore lint/suspicious/noExplicitAny: Elysia macro context type not fully expressible
        beforeHandle: async ({ store, request, error }: any) => {
          const authResult = await authenticateRequest(request);
          if (!authResult) {
            return error(401, { error: { type: "unauthorized", message: "Not authenticated" } });
          }
          store.user = authResult.user;
          store.authSession = authResult.authSession;
          store.authEnvironmentId = authResult.authEnvironmentId;
          store.authContext = authResult.authContext;
          store.actor = authResult.authContext ? toActorContext(authResult.authContext) : null;
          enrichAlsContext(store.user, store.authContext);
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
  });
