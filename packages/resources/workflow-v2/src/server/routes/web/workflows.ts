import { createLogger } from "@fenix/logger";
import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import { Elysia } from "elysia";
import * as z from "zod/v4";
import { createWorkflowAuditWriter, WORKFLOW_AUDIT_ACTIONS } from "../../services/audit-trail";
import { callUpstream, type UpstreamCallResult } from "../../services/upstream-client";
import { listWorkflowsWithPublishStatus } from "../../services/workflow-publish-state";
import {
  findWorkflowById,
  registerWorkflow,
  renameWorkflow,
  softDeleteWorkflow,
  WorkflowRegistrationConflictError,
  WorkflowRegistrationFailedError,
} from "../../services/workflow-registry";
import type { WorkflowV2RouteDependencies } from "../dependencies";
import {
  bindingFailure,
  compensateOrphanWorkflow,
  failBody,
  isUpstreamDeleteAccepted,
  isUpstreamSuccess,
  NOT_FOUND_FAILURE,
  readActor,
  readPath,
  resolveBinding,
  UNAUTHENTICATED_FAILURE,
  upstreamAuditResult,
  upstreamFailure,
  type WorkflowV2UpstreamCall,
} from "./workflow-http";

/**
 * `/web/workflow-v2/workflows` — 本地注册表的列表、创建、重命名与删除；发布记录的读出口在
 * `workflow-publish.ts`（发布动作已于 2026-10-10 撤除，平台只读上游状态）。
 *
 * 归属校验全部落在服务端：组织谓词只从会话上下文推导，创建/改名注入的 `space_id` / `project_id` 取自
 * `workflow_v2_platform_account` / `workflow_v2_org_app`，客户端同名入参一律被忽略（冻结 §4.3/§6）。
 *
 * 删除走软删（`active` → `pending_delete`），`force` 只影响删除策略的选择：`deleted` 表示本地行是否已从
 * 控制台移除，上游删除结果进日志与审计、失败由对账任务重试。
 *
 * 审计（3C）：关键动作经 `createWorkflowAuditWriter` 落 `workflow_v2_audit_log`，**只记录真的发生了动作的
 * 请求**——归属 404、未绑定 409 这类前置校验失败既没有本地写入也没有上游调用，只留日志，避免把存在性探测
 * 与噪音写进流水；审计写入失败降级为日志，不改变主流程结果（见 `services/audit-trail.ts`）。
 *
 * 上游调用经 `options.callUpstream` 端口（缺省 `callUpstream`）：测试可注入替身而不触达真实上游与真实会话。
 */

const logger = createLogger("wf2-workflows");

/** 未指定图标时的默认值（上游 `create` 的 `icon_uri` 必填，见契约快照 §2 第 5、6 行）。 */
const DEFAULT_WORKFLOW_ICON_URI = "default_icon/default_workflow_icon.png";

/** 路由工厂的可选注入面；只用于包内测试与联调替身。 */
export interface WorkflowV2WorkflowRouteOptions {
  readonly callUpstream?: WorkflowV2UpstreamCall;
}

// 端口类型定义在 `workflow-http.ts`（发布路由也要用同一份），此处按既有引用路径转出。
export type { WorkflowV2UpstreamCall };

const WorkflowIdParamsSchema = z.object({ id: z.string().min(1) });

const WorkflowListQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  size: z.coerce.number().int().positive().max(100).optional().default(20),
  name: z.string().trim().min(1).optional(),
});

const CreateWorkflowBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  desc: z.string().max(2000).optional(),
  iconUri: z.string().min(1).optional(),
});

const UpdateWorkflowBodySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  desc: z.string().max(2000).optional(),
  iconUri: z.string().min(1).optional(),
});

// 不能写 `z.coerce.boolean()`：它把字符串 "false" 也解析成 true。
const DeleteWorkflowQuerySchema = z.object({ force: z.enum(["true", "false"]).optional() });

const WorkflowItemSchema = z.object({
  id: z.string(),
  upstreamWorkflowId: z.string(),
  appId: z.string(),
  name: z.string(),
  ownerUserId: z.string(),
  visibility: z.string(),
  /**
   * 上游发布态（`workflow_detail_info` 的 `latest_flow_version`）：`unknown` 表示本次没读到，
   * 前端**必须**与「未发布」分开呈现（见 `services/workflow-publish-state.ts`）。
   */
  publishState: z.enum(["published", "unpublished", "unknown"]),
  /** 上游当前发布版本；仅 `published` 时非 null。 */
  publishedVersion: z.string().nullable(),
  syncState: z.enum(["active", "pending_delete"]),
  updatedAt: z.string(),
});

const WorkflowListResponseSchema = WebOkSchema(
  z.object({ items: z.array(WorkflowItemSchema), total: z.number().int() }),
);
const CreateWorkflowResponseSchema = WebOkSchema(z.object({ id: z.string(), upstreamWorkflowId: z.string() }));
const UpdateWorkflowResponseSchema = WebOkSchema(z.object({ ok: z.literal(true) }));
const DeleteWorkflowResponseSchema = WebOkSchema(z.object({ deleted: z.boolean(), strategy: z.number().nullable() }));

export function createWebWorkflowV2WorkflowRoutes(
  deps: WorkflowV2RouteDependencies,
  options: WorkflowV2WorkflowRouteOptions = {},
) {
  const upstream = options.callUpstream ?? callUpstream;
  const app = new Elysia({ name: "web-workflow-v2-workflows" }).use(deps.authGuardPlugin);

  app.get(
    "/workflows",
    async ({ store, query, status }) => {
      const actor = readActor(store);
      if (!actor) return status(401, failBody(UNAUTHENTICATED_FAILURE));
      // 已软删（pending_delete）的记录不在可见集里：控制台看不到，也就不会再有人对它发请求。
      // 绑定解析走 `resolveBinding`（与发布、发布记录、运行日志**同一口径**）：台账缺行时按需引导自愈，
      // 状态列才能与同一页面的其它读路径给出同一个真相；绑定不可用时不 409（页面有自己的引导屏），
      // 只把状态降级成「未知」。
      const resolution = await resolveBinding(actor.organizationId);
      const page = await listWorkflowsWithPublishStatus(
        actor.organizationId,
        { page: query.page, size: query.size, name: query.name },
        resolution.kind === "ready"
          ? { platformSpaceId: resolution.binding.platformSpaceId, unavailableReason: null }
          : { platformSpaceId: null, unavailableReason: resolution.kind },
        { callUpstream: upstream },
      );
      return { success: true as const, data: page };
    },
    {
      sessionAuth: true,
      query: WorkflowListQuerySchema,
      response: { 200: WorkflowListResponseSchema, 401: WebErrSchema },
      detail: {
        tags: ["Workflow V2"],
        summary: "列出当前组织的工作流",
        description:
          "query page/size/name，返回 { items, total }。列表项来自本地注册表（已软删的不可见），" +
          "`publishState` / `publishedVersion` 取自上游当前发布版本：`unknown` 表示本次未读到，" +
          "不等于「未发布」。绑定解析与其它读路径同口径（台账缺行时按需自愈），不可用时只降级状态、不影响列表。",
      },
    },
  );

  app.post(
    "/workflows",
    async ({ store, body, status }) => {
      const actor = readActor(store);
      if (!actor) return status(401, failBody(UNAUTHENTICATED_FAILURE));
      const resolution = await resolveBinding(actor.organizationId);
      if (resolution.kind !== "ready") {
        const failure = bindingFailure(resolution.kind);
        return status(failure.httpStatus, failBody(failure.body));
      }
      const { binding } = resolution;
      const context = { organizationId: actor.organizationId };
      const audit = createWorkflowAuditWriter({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: WORKFLOW_AUDIT_ACTIONS.create,
        upstreamWorkflowId: null,
      });

      let created: UpstreamCallResult;
      try {
        created = await upstream({
          path: "/api/workflow_api/create",
          body: {
            // space_id / project_id 由服务端注入：请求体里的同名值即使存在也不会被采用（冻结 §6）。
            name: body.name,
            desc: body.desc ?? "",
            icon_uri: body.iconUri ?? DEFAULT_WORKFLOW_ICON_URI,
            space_id: binding.platformSpaceId,
            project_id: binding.appId,
          },
        });
      } catch (error) {
        const failure = upstreamFailure("创建 workflow", { thrown: error }, context);
        await audit(upstreamAuditResult(failure), failure.body.code);
        return status(failure.httpStatus, failBody(failure.body));
      }
      if (!isUpstreamSuccess(created)) {
        const failure = upstreamFailure("创建 workflow", { result: created }, context);
        await audit(upstreamAuditResult(failure), failure.body.code);
        return status(failure.httpStatus, failBody(failure.body));
      }
      const upstreamWorkflowId = readPath(created.body, ["data", "workflow_id"]);
      if (typeof upstreamWorkflowId !== "string" || upstreamWorkflowId.length === 0) {
        const failure = upstreamFailure("创建 workflow（响应缺少 workflow_id）", { result: created }, context);
        await audit(upstreamAuditResult(failure), failure.body.code);
        return status(failure.httpStatus, failBody(failure.body));
      }
      // 身份在登记成功后才确定：后续审计行都带上它，上面的失败分支只能留 null。
      const auditCreated = createWorkflowAuditWriter({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: WORKFLOW_AUDIT_ACTIONS.create,
        upstreamWorkflowId,
      });

      try {
        const record = await registerWorkflow({
          organizationId: actor.organizationId,
          upstreamWorkflowId,
          appId: binding.appId,
          name: body.name,
          ownerUserId: actor.userId,
          visibility: "private",
        });
        await auditCreated("ok");
        return { success: true as const, data: { id: record.id, upstreamWorkflowId: record.upstreamWorkflowId } };
      } catch (error) {
        if (error instanceof WorkflowRegistrationConflictError) {
          logger.warn("workflow-v2 创建命中已登记身份", { ...context, upstreamWorkflowId, reason: error.reason });
          // 冲突时身份已存在（可能属于别的组织）：审计只记「本次动作被拒」，不回显任何已有记录字段。
          await auditCreated("conflict", "WORKFLOW_ALREADY_REGISTERED");
          return status(409, failBody({ code: "WORKFLOW_ALREADY_REGISTERED", message: "该工作流已被登记" }));
        }
        if (error instanceof WorkflowRegistrationFailedError) {
          await compensateOrphanWorkflow(upstream, binding, context, upstreamWorkflowId);
          logger.error("workflow-v2 本地登记失败", {
            ...context,
            upstreamWorkflowId,
            cleanupMarkerRecorded: error.cleanupMarkerRecorded,
          });
          // 补偿删除的「待清理」标记由注册表自己写审计（`workflow.create.compensation`），这里只记本次结果。
          await auditCreated("registration_failed", "WORKFLOW_REGISTRATION_FAILED");
          return status(
            500,
            failBody({ code: "WORKFLOW_REGISTRATION_FAILED", message: "工作流已在画布侧创建但本地登记失败" }),
          );
        }
        throw error;
      }
    },
    {
      sessionAuth: true,
      body: CreateWorkflowBodySchema,
      response: {
        200: CreateWorkflowResponseSchema,
        401: WebErrSchema,
        409: WebErrSchema,
        500: WebErrSchema,
        502: WebErrSchema,
        503: WebErrSchema,
        504: WebErrSchema,
      },
      detail: {
        tags: ["Workflow V2"],
        summary: "创建并登记工作流",
        description:
          "请求体 { name, desc?, iconUri? }，返回 { id, upstreamWorkflowId }。服务端先调上游 `create`（注入平台 " +
          "space_id 与本组织的 project_id），再写本地注册表；本地登记失败时尽力删除上游对象并记录待清理标记。",
      },
    },
  );

  app.patch(
    "/workflows/:id",
    async ({ store, params, body, status }) => {
      const actor = readActor(store);
      if (!actor) return status(401, failBody(UNAUTHENTICATED_FAILURE));
      if (body.name === undefined && body.desc === undefined && body.iconUri === undefined) {
        return status(400, failBody({ code: "INVALID_REQUEST", message: "name/desc/iconUri 至少需要一个" }));
      }
      const record = await findWorkflowById(actor.organizationId, params.id);
      if (!record) return status(404, failBody(NOT_FOUND_FAILURE));
      const resolution = await resolveBinding(actor.organizationId);
      if (resolution.kind !== "ready") {
        const failure = bindingFailure(resolution.kind);
        return status(failure.httpStatus, failBody(failure.body));
      }
      const context = { organizationId: actor.organizationId, upstreamWorkflowId: record.upstreamWorkflowId };
      const audit = createWorkflowAuditWriter({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: WORKFLOW_AUDIT_ACTIONS.updateMeta,
        upstreamWorkflowId: record.upstreamWorkflowId,
      });

      let updated: UpstreamCallResult;
      try {
        updated = await upstream({
          path: "/api/workflow_api/update_meta",
          body: {
            workflow_id: record.upstreamWorkflowId,
            space_id: resolution.binding.platformSpaceId,
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.desc !== undefined ? { desc: body.desc } : {}),
            ...(body.iconUri !== undefined ? { icon_uri: body.iconUri } : {}),
          },
        });
      } catch (error) {
        const failure = upstreamFailure("更新 workflow 元数据", { thrown: error }, context);
        await audit(upstreamAuditResult(failure), failure.body.code);
        return status(failure.httpStatus, failBody(failure.body));
      }
      if (!isUpstreamSuccess(updated)) {
        const failure = upstreamFailure("更新 workflow 元数据", { result: updated }, context);
        await audit(upstreamAuditResult(failure), failure.body.code);
        return status(failure.httpStatus, failBody(failure.body));
      }
      // 上游是元数据真相源，本地只镜像 name；镜像更新失败不回滚上游（上游已生效），留日志由对账校正。
      if (body.name !== undefined && !(await renameWorkflow(actor.organizationId, params.id, body.name))) {
        logger.error("workflow-v2 本地名称镜像更新失败（上游已生效）", context);
        await audit("failed", "WORKFLOW_NOT_FOUND");
        return status(404, failBody(NOT_FOUND_FAILURE));
      }
      await audit("ok");
      return { success: true as const, data: { ok: true as const } };
    },
    {
      sessionAuth: true,
      params: WorkflowIdParamsSchema,
      body: UpdateWorkflowBodySchema,
      response: {
        200: UpdateWorkflowResponseSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        404: WebErrSchema,
        409: WebErrSchema,
        502: WebErrSchema,
        503: WebErrSchema,
        504: WebErrSchema,
      },
      detail: {
        tags: ["Workflow V2"],
        summary: "更新工作流元数据",
        description:
          "请求体 { name?, desc?, iconUri? }（至少一项），返回 { ok }；本地只镜像 name，其余字段以上游为准。",
      },
    },
  );

  app.delete(
    "/workflows/:id",
    async ({ store, params, query, status }) => {
      const actor = readActor(store);
      if (!actor) return status(401, failBody(UNAUTHENTICATED_FAILURE));
      const record = await findWorkflowById(actor.organizationId, params.id);
      if (!record) return status(404, failBody(NOT_FOUND_FAILURE));
      const force = query.force === "true";
      const context = { organizationId: actor.organizationId, upstreamWorkflowId: record.upstreamWorkflowId };
      // 删除是「本地决策 + 上游收敛」两段事实，分两条动作各记一条：`workflow.delete` 记请求与本地结论，
      // `workflow.delete.upstream` 记上游结果（对账任务按前者捞取待收敛的对象）。
      const auditDelete = createWorkflowAuditWriter({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: WORKFLOW_AUDIT_ACTIONS.delete,
        upstreamWorkflowId: record.upstreamWorkflowId,
      });
      const auditUpstreamDelete = createWorkflowAuditWriter({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: WORKFLOW_AUDIT_ACTIONS.deleteUpstream,
        upstreamWorkflowId: record.upstreamWorkflowId,
      });
      const resolution = await resolveBinding(actor.organizationId);
      if (resolution.kind !== "ready") {
        // 没有可注入的 space_id 就调不动上游删除；本地软删照做，上游删除留给对账任务。
        await softDeleteWorkflow(actor.organizationId, record.upstreamWorkflowId);
        logger.warn("workflow-v2 租户绑定不可用，仅本地软删", context);
        await auditDelete("pending_delete");
        return { success: true as const, data: { deleted: true, strategy: null } };
      }
      const { binding } = resolution;

      let strategy: number | null = null;
      try {
        const decision = await upstream({
          path: "/api/workflow_api/delete_strategy",
          body: { workflow_id: record.upstreamWorkflowId, space_id: binding.platformSpaceId },
        });
        const data = readPath(decision.body, ["data"]);
        strategy = typeof data === "number" ? data : null;
      } catch (error) {
        if (!force) {
          const failure = upstreamFailure("查询删除策略", { thrown: error }, context);
          await auditDelete(upstreamAuditResult(failure), failure.body.code);
          return status(failure.httpStatus, failBody(failure.body));
        }
        logger.warn("workflow-v2 删除策略不可读但 force=true，继续删除", context);
      }
      // 策略非 0 表示上游拒绝直接删除（首发审核中 / 需先下架）：非 force 时不落本地软删，用户可先下架。
      if (!force && strategy !== 0) {
        await auditDelete("strategy_rejected");
        return { success: true as const, data: { deleted: false, strategy } };
      }

      await softDeleteWorkflow(actor.organizationId, record.upstreamWorkflowId);
      await auditDelete("pending_delete");
      try {
        const result = await upstream({
          path: "/api/workflow_api/delete",
          body: { workflow_id: record.upstreamWorkflowId, space_id: binding.platformSpaceId },
        });
        if (!isUpstreamDeleteAccepted(result)) {
          logger.error("workflow-v2 上游删除被拒绝，本地已软删，留待对账任务重试", {
            ...context,
            upstreamStatus: result.status,
            upstreamCode: readPath(result.body, ["code"]),
          });
          await auditUpstreamDelete("upstream_rejected", "UPSTREAM_REJECTED");
        } else {
          await auditUpstreamDelete("ok");
        }
      } catch (error) {
        logger.error("workflow-v2 上游删除调用失败，本地已软删，留待对账任务重试", {
          ...context,
          error: error instanceof Error ? error.message : String(error),
        });
        await auditUpstreamDelete("upstream_unavailable", "UPSTREAM_UNAVAILABLE");
      }
      // deleted 表达「已从控制台列表移除」（本地软删已完成）；上游删除结果看日志、审计与对账任务。
      return { success: true as const, data: { deleted: true, strategy } };
    },
    {
      sessionAuth: true,
      params: WorkflowIdParamsSchema,
      query: DeleteWorkflowQuerySchema,
      response: {
        200: DeleteWorkflowResponseSchema,
        401: WebErrSchema,
        404: WebErrSchema,
        502: WebErrSchema,
        503: WebErrSchema,
        504: WebErrSchema,
      },
      detail: {
        tags: ["Workflow V2"],
        summary: "删除工作流",
        description:
          "query force?，返回 { deleted, strategy }。先探上游删除策略（0=可删 / 1=首发审核中 / 2=需先下架），非 force " +
          "且策略非 0 时不删除；删除即先置本地软删再调上游，上游失败由对账任务重试。",
      },
    },
  );

  return app;
}
