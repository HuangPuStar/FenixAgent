/**
 * `GET /web/workflow-v2/run-records` — 「运行日志」视图的读路径。
 *
 * 与发布记录（`workflow-publish.ts` 的 `/workflows/:id/publish-records`）的差别只在**入口层级**：运行日志是
 * 页面级视图（列表页页头入口），因此不挂在单个 workflow 上——`workflowId` 是**可选筛选**（缺省＝全部工作流），
 * 值取本地主键，归属仍由服务端按本地注册表判定（客户端不参与身份拼装，也不接触上游 ID）。
 *
 * 两段数据（细节见 `services/workflow-run-records.ts` 文件头）：
 * - **上游运行清单**：转发 `POST /api/workflow_api/list_spans`（上游 2026-10-09 `3a028cf1` 起为真实实现；
 *   在此之前平台曾临时只读直连上游库，已按 ADR `2026-10-09-workflow-v2-upstream-db-read.md` 的移除条件删除）。
 *   `workflow_id` 是上游必填，因此「全部工作流」是**有限扇出 + 平台侧合并**（上界见 `RUN_LOG_WORKFLOW_LIMIT`）；
 *   查询窗口（最近 7 天）与 `limit` 由服务端显式传，客户端不能自定义。
 * - **平台侧记录**（`platformRuns`）：平台触发的运行在本地审计流水里的留痕（永远不抛错，读不到只降级）。
 *
 * 其余口径与发布记录逐条对齐：
 * - 前置链 `readActor` → `resolveBinding` →（筛选时）`findWorkflowById`：未认证 401、未绑定 409、绑定降级 503、
 *   跨组织与不存在同形 404；
 * - 绑定门含**按需引导**：平台账号台账缺行而绑定行仍在时先自愈一次，仍失败回 503 `PLATFORM_ACCOUNT_NOT_PROVISIONED`
 *   （用户修不了的状态不引导去列表页初始化，详见 `workflow-http.ts` 的 `resolveBinding`）；
 * - 上游失败经 `upstreamFailure` 统一映射（502/503/504）：**任一目标失败即整批失败**——部分成功会静默少显示
 *   某些工作流的记录，用户看到的是「这些工作流没有运行过」，而事实是「没读到」。
 * - 上游为空是**合法空态**（`items: []` 走 200）：该工作流在窗口内确实没有运行。
 *
 * 为什么筛选选项（`workflows`）与记录同一次响应返回：两者是同一个视图的两半，拆成两个请求会多出一条独立的
 * 失败路径与「一半新一半旧」的中间态，而选项本身不超过 `RUN_LOG_OPTION_LIMIT` 条、无翻页语义。
 */

import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import { Elysia } from "elysia";
import * as z from "zod/v4";
import { callUpstream } from "../../services/upstream-client";
import { findWorkflowById, listWorkflows } from "../../services/workflow-registry";
import { fetchWorkflowRunRecords, type WorkflowRunTarget } from "../../services/workflow-run-records";
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

/** 筛选选项条数上界（与列表端点的 `size` 上界一致：超出部分不翻页，UI 的筛选器本就不是目录）。 */
const RUN_LOG_OPTION_LIMIT = 100;

/**
 * 「全部工作流」时扫描的工作流条数上界。
 *
 * 上游 `list_spans` 的 `workflow_id` 是必填，所以「全部」只能是有限扇出：本常量同时是**并发上界**（一个目标
 * 一次调用）。取值保守——上游会话是单账号共享的，用一次页面级读取把它打满没有收益。
 */
const RUN_LOG_WORKFLOW_LIMIT = 10;

const RunRecordsQuerySchema = z.object({
  /** 本地主键；缺省＝全部工作流（组织内前若干个）。 */
  workflowId: z.string().min(1).optional(),
});

/**
 * 运行记录条目：字段与服务层 `WorkflowRunRecord` 一一对应（上游缺失的一律 null，不省略键）。
 *
 * `mode` / `status` 认不出的取值由服务层归一成 null（不猜）；`status` 的取值集与上游
 * `WorkflowExeStatus` 一致（1 运行中 / 2 成功 / 3 失败 / 4 取消 / 5 中断）。
 */
const RunRecordSchema = z.object({
  workflowId: z.string().nullable(),
  workflowName: z.string().nullable(),
  executeId: z.string().nullable(),
  logId: z.string().nullable(),
  version: z.string().nullable(),
  mode: z.enum(["debug", "release", "node_debug"]).nullable(),
  status: z.enum(["running", "succeeded", "failed", "canceled", "interrupted"]).nullable(),
  durationMs: z.number().nullable(),
  createdAt: z.string().nullable(),
  errorCode: z.string().nullable(),
  nodeCount: z.number().nullable(),
});

/** 平台侧运行记录（本地审计流水）：平台触发的运行才有，与上游执行列表分开展示。 */
const PlatformRunSchema = z.object({
  upstreamWorkflowId: z.string().nullable(),
  occurredAt: z.string(),
  result: z.string(),
  errorCode: z.string().nullable(),
});

const RunRecordsResponseSchema = WebOkSchema(
  z.object({
    items: z.array(RunRecordSchema),
    platformRuns: z.array(PlatformRunSchema),
    /** 筛选选项：组织内工作流（本地主键 + 名称），供视图的筛选器渲染。 */
    workflows: z.array(z.object({ id: z.string(), name: z.string() })),
    /** 本次实际扫描的工作流数（「全部」时等于扇出上界与实际条数的较小者）。 */
    scannedWorkflows: z.number(),
    /** 组织内工作流总数：与 `scannedWorkflows` 一起说明「全部」并不等于「所有工作流」（UI 据此给出提示）。 */
    workflowTotal: z.number(),
    /** 命中数超过上屏上界，列表已裁剪。 */
    truncated: z.boolean(),
    /**
     * 上游可能还有更早的运行：任一目标返回的条数等于请求页大小（上游没有 `has_more`/游标，只能按页满推断，
     * 见服务层 `WorkflowRunRecords.hasMoreUpstream`；恰好一页时会有假阳性）。
     */
    hasMoreUpstream: z.boolean(),
  }),
);

export function createWebWorkflowV2RunRoutes(
  deps: WorkflowV2RouteDependencies,
  options: WorkflowV2WorkflowRouteOptions = {},
) {
  const upstream: WorkflowV2UpstreamCall = options.callUpstream ?? callUpstream;
  const app = new Elysia({ name: "web-workflow-v2-runs" }).use(deps.authGuardPlugin);

  app.get(
    "/run-records",
    async ({ store, query, status }) => {
      const actor = readActor(store);
      if (!actor) return status(401, failBody(UNAUTHENTICATED_FAILURE));
      const resolution = await resolveBinding(actor.organizationId);
      if (resolution.kind !== "ready") {
        const failure = bindingFailure(resolution.kind);
        return status(failure.httpStatus, failBody(failure.body));
      }

      // 选项固定取第一页（注册表按创建时间倒序，见仓储的 orderBy）：筛选器给的是「最近创建的一批」，
      // 超出 100 个的工作流不在选项里（返回 `workflowTotal` 让界面说得出这件事）。
      const catalog = await listWorkflows(actor.organizationId, { page: 1, size: RUN_LOG_OPTION_LIMIT });

      let targets: WorkflowRunTarget[];
      if (query.workflowId !== undefined) {
        const record = await findWorkflowById(actor.organizationId, query.workflowId);
        if (!record) return status(404, failBody(NOT_FOUND_FAILURE));
        targets = [{ upstreamWorkflowId: record.upstreamWorkflowId, name: record.name }];
      } else {
        targets = catalog.items
          .slice(0, RUN_LOG_WORKFLOW_LIMIT)
          .map((item) => ({ upstreamWorkflowId: item.upstreamWorkflowId, name: item.name }));
      }

      const endAtMs = Date.now();
      const context = { organizationId: actor.organizationId, scannedWorkflows: targets.length };

      let outcome: Awaited<ReturnType<typeof fetchWorkflowRunRecords>>;
      try {
        outcome = await fetchWorkflowRunRecords(
          { organizationId: actor.organizationId, targets, endAtMs },
          { callUpstream: upstream },
        );
      } catch (error) {
        const failure = upstreamFailure("读取运行记录", { thrown: error }, context);
        return status(failure.httpStatus, failBody(failure.body));
      }
      if (!outcome.ok) {
        const failure = upstreamFailure("读取运行记录", { result: outcome.result }, context);
        return status(failure.httpStatus, failBody(failure.body));
      }

      return {
        success: true as const,
        data: {
          items: outcome.records.items,
          platformRuns: outcome.records.platformRuns,
          workflows: catalog.items.map((item) => ({ id: item.id, name: item.name })),
          scannedWorkflows: targets.length,
          workflowTotal: catalog.total,
          truncated: outcome.records.truncated,
          hasMoreUpstream: outcome.records.hasMoreUpstream,
        },
      };
    },
    {
      sessionAuth: true,
      query: RunRecordsQuerySchema,
      response: {
        200: RunRecordsResponseSchema,
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
        summary: "读取组织内工作流的运行记录",
        description:
          "返回 { items, platformRuns, workflows, scannedWorkflows, workflowTotal, truncated, hasMoreUpstream }。" +
          "items 是上游运行" +
          "清单（服务端转发 `list_spans`，按工作流查询：`workflowId` 缺省时扇出组织内前若干个工作流并在平台侧" +
          "按开始时间倒序合并、超上屏上界裁剪），窗口固定最近 7 天；平台侧不保存运行记录。上游无记录时 items 为" +
          "空数组（合法空态，不是失败）；上游失败按统一映射（502/503/504），任一目标失败即整批失败。" +
          "platformRuns 是平台触发的运行（本地审计；画布内的试运行不经过平台，不在其中）。",
      },
    },
  );

  return app;
}
