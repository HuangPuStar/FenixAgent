import { createLogger } from "@fenix/logger";
import type { MemberRole, MembershipSummary } from "@fenix/platform-sdk";
import { getAuth } from "../auth/better-auth";
import { findMembershipRolesByUserId } from "../repositories/organization-member";
import { findUserBasicInfoById } from "../repositories/user";
import { toMemberRole } from "./member-role";

/**
 * 请求身份解析：把一次 HTTP/WebSocket 请求的凭据解析成身份主体。
 *
 * 迁移自 `apps/server/src/plugins/auth.ts` 的 `authenticateRequest` 全链路（CE 阶段 2 任务 1.2），
 * 凭据顺序逐字保留：better-auth session cookie → Environment Secret → better-auth API Key。
 *
 * 凭据路径的组织上下文：`organizationId` 只当作「当前组织入口」——Environment Secret 取 environment
 * 绑定的组织，API key 取 key metadata；**角色与全量成员关系一律回成员表读当前值**（迁移时保留的
 * 「按凭据自带角色授权」已按台账 C8 校正）。凭据自带的 role 是创建期快照，用户被降级或移出组织后
 * 仍按旧角色授权就是越权窗口。组织不在用户的成员关系里、或成员关系不可验证时凭据不成立，一律保守拒绝。
 *
 * 边界（与宿主的职责切分）：
 * - 宿主保留测试 seam（`setTestAuth`）、ALS 上下文注入与 active organization 解析
 *   （`apps/server/src/services/org-context.ts`，含 60 秒进程内缓存）。session 路径本次返回的
 *   `authSession` 非空、`credentialOrganization` 为 null，宿主据此调用 `loadOrgContext` 补齐组织
 *   上下文；凭据路径（API key / Environment Secret）直接使用 `credentialOrganization`，与迁移前
 *   完全一致。identity 包不复制宿主缓存与测试 seam。
 * - `AppError` 是宿主错误类（`apps/server/src/errors.ts`），本包不能导入。限流一类需要携带 HTTP
 *   状态与稳定错误码的失败改为抛 {@link IdentityAuthenticationError}；宿主适配层需把它映射回
 *   `AppError`（或 error-handler 增加一条分支）以保持 429 / `RATE_LIMITED` 的对外行为不变。
 * - Environment Secret 的存储属于 agent-runtime（`environment` 表），而 `platform-impl` 不得依赖
 *   agent-runtime。凭据**顺序**是身份规则、必须留在本模块，因此这里只保留顺序与判定，把"按密钥
 *   查 environment"抽成宿主注入的 {@link EnvironmentSecretResolver} 端口；宿主（`apps/server`）
 *   用 agent-runtime 的 `environmentRepo.getBySecret` 实现。这样既守住门禁，又避免把凭据链拆成
 *   两处各自维护。
 */

/** 凭据路径的日志器；只记录成员关系复核失败，不记录凭据本身。 */
const log = createLogger("identity-auth");

/** 认证主体：只含展示与审计需要的最小字段，不含凭据。 */
export interface IdentityAuthenticationUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

/** better-auth session 的最小投影。 */
export interface IdentityAuthenticationSession {
  readonly id: string;
  readonly userId: string;
  readonly token: string;
}

/**
 * 凭据路径（API key / Environment Secret）恢复出的多租户上下文。
 *
 * `organizationId` 只是凭据声明的「当前组织入口」，不携带角色语义：角色与成员关系都必须能在成员表
 * 里找到对应行才成立（见 {@link resolveCredentialOrganization}）。
 */
export interface IdentityAuthenticationContext {
  readonly organizationId: string;
  readonly userId: string;
  /** 当前组织中的角色；取自成员表当前值，不是凭据创建期的快照。 */
  readonly role: MemberRole;
  /** 用户的**全量**成员关系；与 platform-sdk `ActorContext.memberships` 的契约口径一致。 */
  readonly memberships: readonly MembershipSummary[];
}

/** 一次请求解析出的身份主体。 */
export interface IdentityAuthentication {
  readonly user: IdentityAuthenticationUser;
  /** session cookie 路径的会话投影；凭据路径为 null。 */
  readonly authSession: IdentityAuthenticationSession | null;
  /** Environment Secret 命中的 environment ID；其它路径为 null。 */
  readonly authEnvironmentId: string | null;
  /**
   * 凭据路径恢复出的组织上下文；session cookie 路径恒为 null（由宿主解析 active organization）。
   */
  readonly credentialOrganization: IdentityAuthenticationContext | null;
}

/** 认证结果：null 表示请求未携带任何可验证的身份凭据。 */
export type IdentityAuthenticationResult = IdentityAuthentication | null;

/**
 * Environment Secret 命中后的主体投影。
 *
 * 只含本模块判定所需的三个字段，不透出 agent-runtime 的 `EnvironmentRecord`：凭据链留在身份侧，
 * 存储细节留在 agent-runtime 侧。
 */
export interface EnvironmentSecretSubject {
  /** 命中的 environment ID，写入认证结果的 `authEnvironmentId`。 */
  readonly environmentId: string;
  /** environment 属主；secret 请求的审计主体。 */
  readonly userId: string;
  /** environment 绑定的组织；null 表示个人 environment，组织上下文回落为属主 ID。 */
  readonly organizationId: string | null;
}

/**
 * 宿主注入的 Environment Secret 解析端口。
 *
 * 宿主实现须用 agent-runtime 的 `environmentRepo.getBySecret(secret)` 查询，未命中返回 null。
 * 抛错按"凭据不可用"处理，不得向上冒泡成 5xx——认证失败与存储故障对外不可区分。
 */
export type EnvironmentSecretResolver = (secret: string) => Promise<EnvironmentSecretSubject | null>;

/** 身份解析的可选宿主依赖。 */
export interface IdentityAuthenticationDependencies {
  /**
   * Environment Secret 解析器。
   *
   * 缺省时跳过 Environment Secret 分支，请求仍会继续尝试 API Key。生产装配必须提供：缺失会让
   * environment secret 凭据静默失效。
   */
  readonly resolveEnvironmentSecret?: EnvironmentSecretResolver;
}

/** 认证失败中需要携带 HTTP 状态与稳定错误码的错误（例如限流）。 */
export class IdentityAuthenticationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = "IdentityAuthenticationError";
  }
}

/** better-auth `verifyApiKey` 的返回结构在类型上未导出，这里按实际使用的最小形状收窄。 */
interface BetterAuthVerifyApiKeyResult {
  readonly valid: boolean;
  readonly error?: { readonly code?: string } | null;
  readonly key?: {
    readonly referenceId: string;
    readonly organizationId?: string | null;
    /**
     * 只收窄到会被读取的 `organizationId`。
     *
     * metadata 里的 `role` 是创建期快照，本模块不再读取（C8）；不列进类型既能表达"不读"，也让
     * 后续若有代码想按快照授权时先在类型上撞墙。
     */
    readonly metadata?: { readonly organizationId?: string | null } | null;
  } | null;
}

function extractToken(request: Request): string | undefined {
  const authHeader = request.headers.get("Authorization");
  const xApiKey = request.headers.get("x-api-key");
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  return authHeader?.replace("Bearer ", "") || xApiKey || queryToken || undefined;
}

/**
 * 用成员表复核凭据声明的组织入口，产出凭据路径的组织上下文。
 *
 * `organizationId` 只当「当前组织入口」用：凭据自带的角色是创建期快照，角色被降级后仍按旧值授权就是
 * 越权窗口，因此角色只能取自成员表的当前行。
 *
 * 返回 null 表示凭据不成立：该组织不在用户的成员关系里，或成员关系不可验证。调用方据此保守拒绝——
 * 认证失败与存储故障对外不可区分，不得在授权事实未知时放行。
 */
async function resolveCredentialOrganization(
  userId: string,
  organizationId: string,
): Promise<IdentityAuthenticationContext | null> {
  try {
    const rows = await findMembershipRolesByUserId(userId);
    const memberships = rows.map(
      (row): MembershipSummary => ({ organizationId: row.organizationId, role: toMemberRole(row.role) }),
    );
    const current = memberships.find((membership) => membership.organizationId === organizationId);
    if (!current) return null;
    return { organizationId, userId, role: current.role, memberships };
  } catch (error) {
    // 失败原因保留在日志里（不含凭据），对外只表现为认证失败。
    log.warn("Membership lookup failed, rejecting credential authentication", {
      userId,
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * 通过环境密钥或 API key 认证，**不含 session cookie**。
 *
 * 返回 null 表示凭据不可用或不可信（含凭据声明的组织已不在成员关系里、以及成员关系校验异常时的
 * 保守拒绝）。
 *
 * 单独公开是因为宿主的 `apiKeyAuth` 守卫需要"只认凭据"的语义：那条路径不接受 session cookie
 * （带 cookie 的浏览器请求不应经 API key 守卫通过）。若宿主改用 {@link resolveIdentityAuthentication}
 * 再自行判断 session，会多出一次会话查询且判定条件散落两处。
 */
export async function resolveCredentialAuthentication(
  request: Request,
  deps: IdentityAuthenticationDependencies,
): Promise<IdentityAuthentication | null> {
  const token = extractToken(request);
  if (!token) return null;

  // 0. Environment secret match
  const subject = await deps.resolveEnvironmentSecret?.(token);
  if (subject?.userId) {
    const user = await findUserBasicInfoById(subject.userId);
    if (user) {
      // 个人 environment（未绑定组织）回落为属主 ID，沿用既有口径；回落值同样要能在成员表里找到
      // 对应组织，否则没有可归属的角色。
      const credentialOrganization = await resolveCredentialOrganization(
        user.id,
        subject.organizationId ?? subject.userId,
      );
      // 命中 environment 的密钥不会退回当 API key 用：归属不成立即拒绝，不做第二次凭据解释。
      return credentialOrganization
        ? { user, authSession: null, authEnvironmentId: subject.environmentId, credentialOrganization }
        : null;
    }
  }

  // 1. better-auth API Key 验证
  const result = (await getAuth().api.verifyApiKey({ body: { key: token } })) as BetterAuthVerifyApiKeyResult;
  if (!result.valid && result.error?.code === "RATE_LIMITED") {
    throw new IdentityAuthenticationError("API key rate limit exceeded", "RATE_LIMITED", 429);
  }

  const apiKeyMeta = result.valid ? result.key : undefined;
  if (!apiKeyMeta) return null;

  // better-auth API key 统一以 referenceId 表示归属主体；当前配置下它就是创建该 key 的用户 ID。
  // API key 字符串本身不携带组织信息，只能从 key metadata 恢复「当前组织入口」；metadata 里的 role
  // 是创建期快照，不参与判定——角色与成员关系一律回成员表读当前值。
  const user = await findUserBasicInfoById(apiKeyMeta.referenceId);
  if (!user) return null;

  const orgId = apiKeyMeta.organizationId || apiKeyMeta.metadata?.organizationId;
  if (!orgId) return null;

  const credentialOrganization = await resolveCredentialOrganization(user.id, orgId);
  if (!credentialOrganization) return null;

  return {
    user,
    authSession: null,
    authEnvironmentId: null,
    credentialOrganization,
  };
}

/**
 * 统一解析 HTTP / WebSocket 升级请求的认证结果。
 * 优先尝试 session cookie，失败后再 fallback 到 environment secret / API key。
 */
export async function resolveIdentityAuthentication(
  request: Request,
  deps: IdentityAuthenticationDependencies = {},
): Promise<IdentityAuthenticationResult> {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (session?.user) {
    const user = { id: session.user.id, email: session.user.email, name: session.user.name };
    const authSession = {
      id: session.session.id,
      userId: session.session.userId,
      token: session.session.token,
    };

    return {
      user,
      authSession,
      authEnvironmentId: null,
      credentialOrganization: null,
    };
  }

  return resolveCredentialAuthentication(request, deps);
}
