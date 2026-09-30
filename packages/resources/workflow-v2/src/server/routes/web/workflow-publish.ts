import { createLogger } from "@fenix/logger";
import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import { Elysia } from "elysia";
import * as z from "zod/v4";
import { createWorkflowAuditWriter, WORKFLOW_AUDIT_ACTIONS } from "../../services/audit-trail";
import { callUpstream } from "../../services/upstream-client";
import { publishWorkflowVersion } from "../../services/workflow-publish";
import { findWorkflowById, recordPublishedVersion } from "../../services/workflow-registry";
import type { WorkflowV2RouteDependencies } from "../dependencies";
import {
  bindingFailure,
  failBody,
  NOT_FOUND_FAILURE,
  readActor,
  resolveBinding,
  UNAUTHENTICATED_FAILURE,
  upstreamAuditResult,
  upstreamFailure,
  type WorkflowV2UpstreamCall,
} from "./workflow-http";
import type { WorkflowV2WorkflowRouteOptions } from "./workflows";

/**
 * `POST /web/workflow-v2/workflows/:id/publish` — 发布闭环（3B）。
 *
 * 单独成文件而不是塞进 `workflows.ts`：发布是「版本推导 + 上游调用 + 上游业务拒绝映射 + 本地写回」的完整
 * 垂直切片，混进 CRUD 会让那个文件同时承载两套失败语义，也超出单文件行数约束。
 *
 * 上游业务拒绝在本文件映射为控制面错误（形状 `{ success:false, error:{ code, message } }`）：
 * 草稿未验证 / 版本未自增 / 版本名非法 → 409（用户可修复的状态冲突，重试无益），其余上游拒绝 → 502。
 * 传输/会话/熔断失败由 `workflow-http` 的统一映射处理，与其它控制面动作同口径（3C 的复核要求）。
 *
 * 发布成功后把新版本写回本地注册表；写回失败**不**改判发布结果（见 handler 内注释）。
 */

const logger = createLogger("wf2-publish-route");

/** 发布请求（冻结 §4.3）：`description` 是版本说明，`force` 跳过上游的草稿验证前置。 */
const PublishWorkflowBodySchema = z.object({
  description: z.string().max(2000).optional(),
  force: z.boolean().optional(),
});

const WorkflowIdParamsSchema = z.object({ id: z.string().min(1) });

const PublishWorkflowResponseSchema = WebOkSchema(z.object({ version: z.string(), commitId: z.string() }));

export function createWebWorkflowV2PublishRoutes(
  deps: WorkflowV2RouteDependencies,
  options: WorkflowV2WorkflowRouteOptions = {},
) {
  const upstream: WorkflowV2UpstreamCall = options.callUpstream ?? callUpstream;
  const app = new Elysia({ name: "web-workflow-v2-publish" }).use(deps.authGuardPlugin);

  app.post(
    "/workflows/:id/publish",
    async ({ store, params, body, status }) => {
      const actor = readActor(store);
      if (!actor) return status(401, failBody(UNAUTHENTICATED_FAILURE));
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
        action: WORKFLOW_AUDIT_ACTIONS.publish,
        upstreamWorkflowId: record.upstreamWorkflowId,
      });

      let outcome: Awaited<ReturnType<typeof publishWorkflowVersion>>;
      try {
        outcome = await publishWorkflowVersion(
          {
            upstreamWorkflowId: record.upstreamWorkflowId,
            spaceId: resolution.binding.platformSpaceId,
            publishedVersion: record.publishedVersion,
            description: body.description,
            force: body.force,
          },
          { callUpstream: upstream },
        );
      } catch (error) {
        const failure = upstreamFailure("发布 workflow", { thrown: error }, context);
        await audit(upstreamAuditResult(failure), failure.body.code);
        return status(failure.httpStatus, failBody(failure.body));
      }

      if (!outcome.ok) {
        // 上游业务拒绝与「本地版本号不可解析」走同一条路：只归一化错误，不改动本地状态。
        const rejectedByUpstream = outcome.rejection.upstreamCode !== null;
        await audit(rejectedByUpstream ? "upstream_rejected" : "failed", outcome.rejection.code);
        return status(
          outcome.rejection.httpStatus,
          failBody({ code: outcome.rejection.code, message: outcome.rejection.message }),
        );
      }

      // 上游已发布成功 → 写回本地版本。写回失败**不**改判发布结果：上游确实发布了新版本，把它报成失败会让
      // 客户端重试，而重试必然撞上「版本未自增」（下一次自增仍从旧版本推）。缺口留在日志与审计里。
      let versionRecorded = true;
      try {
        const updated = await recordPublishedVersion(actor.organizationId, record.upstreamWorkflowId, outcome.version);
        if (!updated) {
          versionRecorded = false;
          logger.error("workflow-v2 发布成功但本地版本写回未命中行（可能已被并发软删）", context);
        }
      } catch (error) {
        versionRecorded = false;
        logger.error("workflow-v2 发布成功但本地版本写回失败", {
          ...context,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await audit("ok", versionRecorded ? null : "WORKFLOW_VERSION_NOT_RECORDED");
      return { success: true as const, data: { version: outcome.version, commitId: outcome.commitId } };
    },
    {
      sessionAuth: true,
      params: WorkflowIdParamsSchema,
      body: PublishWorkflowBodySchema,
      response: {
        200: PublishWorkflowResponseSchema,
        401: WebErrSchema,
        404: WebErrSchema,
        409: WebErrSchema,
        500: WebErrSchema,
        502: WebErrSchema,
        503: WebErrSchema,
        504: WebErrSchema,
      },
      detail: {
        tags: ["Workflow V2"],
        summary: "发布工作流版本",
        description:
          "请求体 { description?, force? }，返回 { version, commitId }。版本号由服务端从本地注册表推导" +
          "（首发布 v0.0.1，其后 patch 自增）；force=true 跳过上游「草稿必须先通过调试运行」的前置校验；" +
          "上游业务拒绝按码映射（草稿未验证 / 版本未自增 / 版本名非法）。",
      },
    },
  );

  return app;
}
