import { createLogger } from "@fenix/logger";
import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import { Elysia } from "elysia";
import * as z from "zod/v4";
import {
  ensureOrgApp,
  findOrgAppBinding,
  OrgAppBindingError,
  type OrgAppBindingFailure,
  rebindOrgApp,
} from "../../services/org-app-binding";
import { PlatformAccountBootstrapError } from "../../services/platform-account-bootstrap";
import type { WorkflowV2RouteDependencies } from "../dependencies";

/**
 * `/web/workflow-v2/org-app` — 租户 ↔ 上游应用 绑定的管理与查询（设计 §4.3）。
 *
 * 绑定关系是「一个 organization 至多一个 App」的一对一事实（`workflow_v2_org_app` 的两个唯一索引从存储层
 * 保证），因此重绑是显式动作（`/org-app/rebind`）而不是隐式覆盖：静默换 App 会让该租户既有 workflow 全部
 * 失联。`GET` 只读本地（不登录、不探活、不打上游），状态收敛走 `probeOrgAppBinding` 或上层探测到不存在类
 * 错误时的 `markOrgAppDegraded`。
 *
 * 身份只从会话守卫写入的 `store.authContext` 取：组织谓词不来自请求体，客户端传 `organizationId` 一律无效
 * （冻结 §4.3）。重绑要求管理员：本包是叶子模块（无 `@fenix/access-control` 依赖），准入落在路由层，读的
 * 是守卫已归一化的三态角色（owner/admin），未知值按最小权限收敛为 member。
 *
 * 失败映射只用既有错误码（`UNAUTHENTICATED` / `FORBIDDEN` / `NOT_FOUND` / `CONFLICT` / `UPSTREAM_*`），
 * 文案为我方固定文案，不含上游原文、App 归属方信息与凭据。
 */

const logger = createLogger("wf2-org-app-routes");

/** 未绑定时的视图状态：`workflow_v2_org_app` 只存 `active`/`degraded`，「没有绑定」是读出来的第三种状态。 */
const UNBOUND = "unbound";

const OrgAppViewSchema = WebOkSchema(
  z.object({
    appId: z.string().nullable().describe("绑定的上游应用 ID；未绑定时为 null（冻结 §4.3 的 `appId?`）。"),
    status: z
      .enum(["active", "degraded", UNBOUND])
      .describe("active=绑定可用；degraded=上游已明确目标 App 不可用；unbound=当前组织尚未绑定。"),
  }),
).describe("租户 App 绑定视图。");

const CreateOrgAppResponseSchema = WebOkSchema(
  z.object({ appId: z.string().describe("本组织绑定的上游应用 ID。") }),
).describe("创建并绑定租户 App 的响应。");

const RebindOrgAppBodySchema = z.object({
  appId: z.string().trim().min(1).max(64).describe("目标上游应用 ID；必须已存在于平台个人空间。"),
});

const RebindOrgAppResponseSchema = WebOkSchema(z.object({ ok: z.literal(true) })).describe("重绑结果。");

/** 失败信封；**HTTP 状态由调用处的 `status(code, ...)` 给出**（挂在默认 200 上会被响应校验判成 422）。 */
type Failure = { readonly code: string; readonly message: string };
const failBody = (error: Failure) => ({ success: false as const, error });

const UNAUTHENTICATED_FAILURE: Failure = { code: "UNAUTHENTICATED", message: "缺少组织上下文" };
const FORBIDDEN_FAILURE: Failure = { code: "FORBIDDEN", message: "仅组织管理员可重绑工作流应用" };
const SESSION_FAILURE: Failure = { code: "PLATFORM_SESSION_UNAVAILABLE", message: "平台工作流账号不可用" };
const PERSIST_FAILURE: Failure = { code: "INTERNAL_ERROR", message: "本地绑定写入失败" };

/** 绑定失败的对外错误码；取值只用仓库既有码，不新造。 */
type BindingFailureCode = "NOT_FOUND" | "CONFLICT" | "INTERNAL_ERROR" | "UPSTREAM_UNAVAILABLE" | "UPSTREAM_REJECTED";

/** 失败码 → HTTP 状态；每个路由声明自己的子集（建绑路径没有「目标不存在」这一分类）。 */
const BINDING_FAILURE_STATUS: Record<BindingFailureCode, 404 | 409 | 500 | 502> = {
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
  UPSTREAM_UNAVAILABLE: 502,
  UPSTREAM_REJECTED: 502,
};

/**
 * 绑定失败的分类 → 对外文案（两端口径一致）。
 *
 * 目标不存在只可能出现在重绑的目标校验里（建绑从不校验指定 App）；被别的组织占用**不回显占用方**。
 */
function bindingFailureMessage(kind: OrgAppBindingFailure): {
  readonly code: BindingFailureCode;
  readonly message: string;
} {
  switch (kind) {
    case "app_not_found":
      return { code: "NOT_FOUND", message: "目标工作流应用不存在" };
    case "app_taken":
      return { code: "CONFLICT", message: "目标工作流应用已被其它组织绑定" };
    case "upstream_unavailable":
      return { code: "UPSTREAM_UNAVAILABLE", message: "上游服务不可达" };
    case "upstream_rejected":
      return { code: "UPSTREAM_REJECTED", message: "上游拒绝了本次请求" };
    case "persist_failed":
      return { code: "INTERNAL_ERROR", message: PERSIST_FAILURE.message };
  }
}

/** 会话守卫写入 `store.authContext` 的字段中本路由消费的部分；角色取守卫已归一化的三态值。 */
interface OrgAppActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: "owner" | "admin" | "member";
}

/** 从会话上下文取主体；缺组织/用户时返回 null（路由回 401），角色未知按最小权限收敛为 member。 */
function readActor(store: unknown): OrgAppActor | null {
  const candidate = (store as { authContext?: Record<string, unknown> } | null)?.authContext;
  if (!candidate) return null;
  const { organizationId, userId, role } = candidate;
  if (typeof organizationId !== "string" || typeof userId !== "string") return null;
  if (organizationId.length === 0 || userId.length === 0) return null;
  // 守卫已把角色归一化到 owner/admin/member（宿主 auth 插件的口径）；这里再收敛一次，未知值不给管理权限。
  return { organizationId, userId, role: role === "owner" || role === "admin" ? role : "member" };
}

/** 管理动作准入：owner / admin 可重绑（与宿主的角色取值域一致）。 */
const isAdmin = (actor: OrgAppActor): boolean => actor.role === "owner" || actor.role === "admin";

/** 只把失败原因（分类标签，不含上游原文与凭据）写进日志；对外文案由调用处给出。 */
function logBindingFailure(action: string, organizationId: string, error: unknown): void {
  if (error instanceof OrgAppBindingError) {
    logger.error("workflow-v2 租户 App 绑定操作失败", { action, organizationId, kind: error.kind });
    return;
  }
  logger.error("workflow-v2 租户 App 绑定操作抛出未分类异常", {
    action,
    organizationId,
    error: error instanceof Error ? error.message : String(error),
  });
}

export function createWebWorkflowV2OrgAppRoutes(deps: WorkflowV2RouteDependencies) {
  const app = new Elysia({ name: "web-workflow-v2-org-app" }).use(deps.authGuardPlugin);

  app.get(
    "/org-app",
    async ({ store, status }) => {
      const actor = readActor(store);
      if (!actor) return status(401, failBody(UNAUTHENTICATED_FAILURE));
      const binding = await findOrgAppBinding(actor.organizationId);
      return {
        success: true as const,
        data: binding
          ? { appId: binding.appId, status: binding.status }
          : { appId: null, status: UNBOUND as typeof UNBOUND },
      };
    },
    {
      sessionAuth: true,
      response: { 200: OrgAppViewSchema, 401: WebErrSchema },
      detail: {
        tags: ["Workflow V2"],
        summary: "读取当前组织的上游应用 绑定",
        description: "返回 { appId, status }；未绑定时 appId 为 null、status 为 unbound。只读本地，不请求上游。",
      },
    },
  );

  app.post(
    "/org-app",
    async ({ store, status }) => {
      const actor = readActor(store);
      if (!actor) return status(401, failBody(UNAUTHENTICATED_FAILURE));
      try {
        const binding = await ensureOrgApp(actor.organizationId);
        return { success: true as const, data: { appId: binding.appId } };
      } catch (error) {
        // 平台账号引导失败是 503（暂时不可用、可重试）；其余按绑定失败分类映射。
        if (error instanceof PlatformAccountBootstrapError) {
          logger.error("workflow-v2 平台账号引导失败", { organizationId: actor.organizationId, reason: error.reason });
          return status(503, failBody(SESSION_FAILURE));
        }
        logBindingFailure("create", actor.organizationId, error);
        const failure = bindingFailureMessage(error instanceof OrgAppBindingError ? error.kind : "persist_failed");
        if (failure.code === "NOT_FOUND") {
          // 建绑从不校验指定 App，因此不会有「目标不存在」；真出现说明分类被误用，按持久化失败上报。
          return status(500, failBody(PERSIST_FAILURE));
        }
        return status(BINDING_FAILURE_STATUS[failure.code], failBody(failure));
      }
    },
    {
      sessionAuth: true,
      response: {
        200: CreateOrgAppResponseSchema,
        401: WebErrSchema,
        409: WebErrSchema,
        500: WebErrSchema,
        502: WebErrSchema,
        503: WebErrSchema,
      },
      detail: {
        tags: ["Workflow V2"],
        summary: "初始化并绑定当前组织的工作流空间",
        description:
          "无请求体（一键初始化），返回 { appId }；空间展示名由服务端取当前**组织名称**（名称为空时回退默认名），" +
          "客户端提交的名称一律无效。已绑定时幂等返回既有绑定（不重复建 App）；未绑定时先确保平台账号" +
          "（首次使用时登录并落库账号身份），再在平台个人空间下创建 App。并发首次调用收敛到同一个 App。",
      },
    },
  );

  app.post(
    "/org-app/rebind",
    async ({ store, body, status }) => {
      const actor = readActor(store);
      if (!actor) return status(401, failBody(UNAUTHENTICATED_FAILURE));
      if (!isAdmin(actor)) return status(403, failBody(FORBIDDEN_FAILURE));
      try {
        // 返回值当前只用来确认写入成功：控制台只需要 ok，绑定详情由 GET /org-app 读。
        await rebindOrgApp(actor.organizationId, body.appId);
        return { success: true as const, data: { ok: true as const } };
      } catch (error) {
        logBindingFailure("rebind", actor.organizationId, error);
        const failure = bindingFailureMessage(error instanceof OrgAppBindingError ? error.kind : "persist_failed");
        return status(BINDING_FAILURE_STATUS[failure.code], failBody(failure));
      }
    },
    {
      sessionAuth: true,
      body: RebindOrgAppBodySchema,
      response: {
        200: RebindOrgAppResponseSchema,
        401: WebErrSchema,
        403: WebErrSchema,
        404: WebErrSchema,
        409: WebErrSchema,
        500: WebErrSchema,
        502: WebErrSchema,
      },
      detail: {
        tags: ["Workflow V2"],
        summary: "重绑当前组织的上游应用（管理员）",
        description:
          "请求体 { appId }，返回 { ok }。仅 owner/admin 可调用；先向上游确认目标 App 存在，目标不存在返回 404，" +
          "已被其它组织绑定返回 409。归属校验不依赖上游：绑定关系以本地表为真相源。",
      },
    },
  );

  return app;
}
