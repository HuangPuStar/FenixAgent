/**
 * `GET /web/workflow-v2/workflows/:id/publish-records` — 发布记录的**读出口**。
 *
 * 为什么单独成文件：发布记录是「上游应用级记录 + 平台侧审计动作」两条来源的分段读取，形状与 CRUD 的
 * 列表/详情不同，混进 `workflows.ts` 会超出单文件行数约束、也让失败语义分叉。
 *
 * 控制台发布动作（`POST /workflows/:id/publish`）已于 2026-10-10 撤除：发布在上游侧完成（画布 / 上游控制台），
 * 平台不再触发也不承担版本推进；本文件只读。历史 `workflow.publish` 审计行仍经本接口的 `actions` 段展示
 * （控制台发布动作的唯一可见处），因此读路径与审计口径保持不变。
 */

import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import { Elysia } from "elysia";
import * as z from "zod/v4";
import { callUpstream } from "../../services/upstream-client";
import { fetchWorkflowPublishOverview } from "../../services/workflow-publish-records";
import { findWorkflowById } from "../../services/workflow-registry";
import type { WorkflowV2RouteDependencies } from "../dependencies";
import {
  bindingFailure,
  failBody,
  NOT_FOUND_FAILURE,
  readActor,
  resolveBinding,
  UNAUTHENTICATED_FAILURE,
  upstreamFailure,
  type WorkflowV2UpstreamCall,
} from "./workflow-http";
import type { WorkflowV2WorkflowRouteOptions } from "./workflows";

const WorkflowIdParamsSchema = z.object({ id: z.string().min(1) });

/**
 * 渠道发布记录条目：字段与服务层 `WorkflowPublishRecord` 一一对应。
 *
 * 上游记录里没有时间与操作人（thrift `PublishRecordDetail` 无这两个字段），因此这里也不给——不造字段；
 * 记录级 `publish_status` 在该构建恒为 0（不可用），状态改为由渠道结果与打包明细派生（见服务层文件头）。
 */
const PublishChannelSchema = z.object({
  connectorId: z.string().nullable(),
  connectorName: z.string().nullable(),
  status: z.enum(["success", "failed", "auditing", "in_progress", "disabled"]).nullable(),
});

const PublishRecordSchema = z.object({
  version: z.string().nullable(),
  status: z.enum(["done", "pack_failed", "in_progress"]),
  channels: z.array(PublishChannelSchema),
  packFailedResources: z.array(z.string()),
});

/** 平台侧发布动作（本地审计流水）：时间 + 操作人 + 结果。 */
const PublishActionSchema = z.object({
  occurredAt: z.string(),
  actorName: z.string().nullable(),
  result: z.string(),
  errorCode: z.string().nullable(),
});

const PublishOverviewResponseSchema = WebOkSchema(
  z.object({
    current: z.object({ publishedVersion: z.string().nullable() }),
    records: z.array(PublishRecordSchema),
    actions: z.array(PublishActionSchema),
  }),
);

export function createWebWorkflowV2PublishRoutes(
  deps: WorkflowV2RouteDependencies,
  options: WorkflowV2WorkflowRouteOptions = {},
) {
  const upstream: WorkflowV2UpstreamCall = options.callUpstream ?? callUpstream;
  const app = new Elysia({ name: "web-workflow-v2-publish" }).use(deps.authGuardPlugin);

  // 读路径：发布记录与上游当前发布版本**全部来自上游**（本接口不读、不写本地发布记录，理由见服务文件头）。
  // 前置与其它控制面动作同一套（归属 404 → 绑定 409/503 → 上游失败映射），因此「谁能看」的判断不会分叉。
  app.get(
    "/workflows/:id/publish-records",
    async ({ store, params, status }) => {
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

      let outcome: Awaited<ReturnType<typeof fetchWorkflowPublishOverview>>;
      try {
        outcome = await fetchWorkflowPublishOverview(
          {
            upstreamWorkflowId: record.upstreamWorkflowId,
            // 渠道发布记录是**应用级**的读出口（工作流级的 `list_publish_workflow` 在上游是桩实现，见服务层文件头）：
            // appId 取自本地注册表，客户端不参与。
            appId: record.appId,
            spaceId: resolution.binding.platformSpaceId,
            organizationId: actor.organizationId,
          },
          { callUpstream: upstream },
        );
      } catch (error) {
        const failure = upstreamFailure("读取发布记录", { thrown: error }, context);
        return status(failure.httpStatus, failBody(failure.body));
      }
      if (!outcome.ok) {
        const failure = upstreamFailure("读取发布记录", { result: outcome.result }, context);
        return status(failure.httpStatus, failBody(failure.body));
      }
      return { success: true as const, data: outcome.overview };
    },
    {
      sessionAuth: true,
      params: WorkflowIdParamsSchema,
      response: {
        200: PublishOverviewResponseSchema,
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
        summary: "读取工作流的发布记录与上游当前发布版本",
        description:
          "返回 { current: { publishedVersion }, records: [{ version, status, channels, packFailedResources }], " +
          "actions: [{ occurredAt, actorName, result, errorCode }] }，" +
          "current 与 records 取自上游（当前版本取 canvas 的 `workflow_version`，渠道发布记录取应用级 " +
          "`publish_record_list`；工作流级的 `list_publish_workflow` 是上游桩实现、不调用），" +
          "actions 是平台侧发布动作（本地审计；上游只记录发布产物、不记录控制台动作）。" +
          "上游无记录时 records 为空数组（合法空态，不是失败）。",
      },
    },
  );

  return app;
}
