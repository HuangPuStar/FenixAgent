/**
 * 对外触发面：`POST /api/workflow-v2/workflows/:id/run`（`slot: "api"` 的贡献，挂宿主 `/api` 聚合实例）。
 *
 * 「外部系统能触发工作流运行」这一需求的**唯一**入口：调用方用控制台 API Key（`rcs_*`，Bearer）认证，`:id` 是
 * 本地 workflow 主键（客户端不接触上游 ID），服务端按组织谓词解析归属，再以平台账号 PAT 调上游
 * `POST /v1/workflow/run`（运行已发布版本）。协议细节与字段口径见 `services/workflow-run.ts`。
 *
 * 认证**不在此自建**：`.use(deps.authGuardPlugin)` 注入宿主的同一份守卫实例（session cookie → Environment
 * Secret → API Key 的优先级、active organization 提取、测试 seam 都在那份实例里）。Elysia 的 `macro`/`state`
 * 是实例作用域的，自建守卫会让同一进程出现两套互不可见的认证状态。
 *
 * 归属与错误形态：
 * - 未认证/缺组织 401；跨租户与不存在一律 404（同形，不泄漏存在性）；未发布 409；参数不合法 422；
 * - 限流按**调用方身份**（API Key 恢复出的 `userId`）计数，超限 429 + `Retry-After`（阈值见模块 env
 *   `WORKFLOW_V2_API_RATE_LIMIT_PER_MINUTE`）；
 * - 上游传输/会话失败复用控制面的同一张映射表（超时 504 / 网络 502 / 凭据与熔断 503），不造第二套；
 * - 错误体是 `/api/*` 的统一形状 `{ error: { code, message } }`（`ApiErrorResponseSchema`），不是 `/web/*`
 * 的 `{ success, data }`。
 *
 * 审计：真正打到上游的请求才落 `workflow.run.external` 流水（记组织、调用者、上游 workflow ID、结果与错误码；
 * **不记 inputs/outputs 原文**）。前置校验失败（401/404/422）与限流拒绝只留日志——它们没有发生任何动作，
 * 写进流水只会淹没有效记录（与 `/web` 面同口径）。
 */

import { createLogger } from "@fenix/logger";
import { ApiErrorResponseSchema } from "@fenix/platform-sdk";
import { Elysia } from "elysia";
import * as z from "zod/v4";
import { getWorkflowV2Config } from "../../config";
import type { ApiChannelReleaseOutcome } from "../../services/api-channel-release";
import { ensureApiChannelRelease } from "../../services/api-channel-release";
import { createWorkflowAuditWriter, WORKFLOW_AUDIT_ACTIONS } from "../../services/audit-trail";
import { createTokenBucketLimiter, policyPerMinute } from "../../services/rate-limit";
import { callUpstreamOpenApi } from "../../services/upstream-client";
import { findWorkflowById, type WorkflowRecord } from "../../services/workflow-registry";
import {
  normalizeRunParameters,
  runPublishedWorkflow,
  WORKFLOW_NOT_REGISTERED_CODE,
  type WorkflowRunCall,
  type WorkflowRunOutcome,
} from "../../services/workflow-run";
import type { WorkflowV2RouteDependencies } from "../dependencies";
// 上游失败映射与主体解析**复用控制面那一份**（唯一口径）：`workflow-http.ts` 虽在 `web/` 目录下，但它承载的是
// 「上游失败怎么分类」这条与协议面无关的规则；复制一份到 `/api` 面就会造出第二套 502/503/504 判定。
import { readActor, upstreamAuditResult, upstreamFailure } from "../web/workflow-http";

const logger = createLogger("wf2-api-external");

/** API 渠道自愈端口；与 `ensureApiChannelRelease` 同形，便于路由层注入替身。 */
type ApiChannelReleaseCall = (input: {
  readonly upstreamWorkflowId: string;
  readonly appId: string;
}) => Promise<ApiChannelReleaseOutcome>;

/** `/api/*` 的错误信封；文案一律是我方固定文案，不含上游原文与内部实现。 */
const apiError = (code: string, message: string) => ({ error: { code, message } });

/** 未认证（无会话、无 API Key，或已认证但缺 active organization）。 */
const UNAUTHENTICATED = apiError("UNAUTHENTICATED", "缺少调用方身份或组织上下文");
/** 目标在本地不可见：不存在、已软删或跨组织（三者同形）。 */
const NOT_FOUND = apiError("WORKFLOW_NOT_FOUND", "工作流不存在");
/** 调用频率超限；等待秒数写在 `Retry-After` 响应头里。 */
const RATE_LIMITED = apiError("RATE_LIMITED", "调用频率超出限制");

/**
 * 路径参数：本地主键是 `uuid`（见 `db/schema.ts`），因此这里就按 UUID 校验。
 *
 * 不放开成任意字符串：非 UUID 的值会一路进到数据库并触发一条 `invalid input syntax for type uuid` 的查询错误，
 * 对调用方表现为 500。形状校验放在边界上，调用方拿到的是 422「参数不合法」而不是一个内部错误。
 */
const RunWorkflowParamsSchema = z.object({ id: z.string().uuid().describe("控制台里的工作流主键（UUID）。") });

const RunWorkflowBodySchema = z
  .object({
    parameters: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional()
      .describe("工作流入参：可直接给 JSON 对象，或给它的 JSON 字符串（按原样透传给上游）。"),
    isAsync: z
      .boolean()
      .optional()
      .default(false)
      .describe("true 立即返回 executeId（异步运行，结果从上游调试页查看）；false 等待本次运行结束后返回 data。"),
    ext: z
      .object({ user_id: z.string().min(1).optional() })
      .optional()
      .describe("受控透传字段：user_id 作为上游的运行时用户标识，缺省时以上游平台账号身份运行。"),
  })
  .describe("触发工作流运行请求体。");

const RunWorkflowResponseSchema = z
  .object({
    executeId: z.string().nullable().describe("执行 ID（同步与异步都返回）。"),
    data: z.string().nullable().describe("同步执行的输出（上游原样的 JSON 字符串）；异步或未命中时为 null。"),
    token: z.number().int().nullable().describe("本次消耗的 token 数。"),
    cost: z.string().nullable().describe("本次消耗（字符串形态）。"),
    debugUrl: z.string().nullable().describe("上游调试页地址。"),
  })
  .describe("工作流运行结果；字段缺失为 null，不省略键。");

/** 供 OpenAPI 展示认证方式；鉴权本身由注入的宿主守卫完成（声明为可选，未认证仍是 401）。 */
const RunWorkflowHeadersSchema = z.object({
  authorization: z.string().optional().describe("Bearer 凭据：控制台 API Key（`rcs_*`），`Bearer <api_key>`。"),
});

/** 路由工厂的可选注入面；只用于包内测试与联调替身。 */
export interface WorkflowV2ExternalApiRouteOptions {
  readonly callUpstreamOpenApi?: WorkflowRunCall;
  /** API 渠道自愈端口；缺省即真实实现（测试注入替身，不触达真实上游与会话）。 */
  readonly ensureApiChannelRelease?: ApiChannelReleaseCall;
}

/** 进程内令牌桶（多副本下实际阈值 ≈ 配置值 × 副本数，全局阈值归部署层，与画布面同口径）。 */
const rateLimiter = createTokenBucketLimiter();

/** 创建 `/api/workflow-v2/*` 对外触发路由。 */
export function createApiWorkflowV2Routes(
  deps: WorkflowV2RouteDependencies,
  options: WorkflowV2ExternalApiRouteOptions = {},
) {
  const upstream: WorkflowRunCall = options.callUpstreamOpenApi ?? callUpstreamOpenApi;
  const release: ApiChannelReleaseCall = options.ensureApiChannelRelease ?? ensureApiChannelRelease;
  const app = new Elysia({ name: "api-workflow-v2", prefix: "/api/workflow-v2" }).use(deps.authGuardPlugin);

  /**
   * 运行一次；若上游回执是「当前发布版本未登记到 API 渠道」（`777777778` → 409），
   * 先做一次有界自愈（把该版本发布到 API 渠道）再重试**一次**运行。
   *
   * 为什么要重试：登记的缺失是**平台侧的前置条件**（平台从未把租户 App 发布到渠道），不是调用方的参数问题；
   * 不重试的话每个真实调用都会白跑一次失败回执。为什么只重试一次：自愈本身有单飞、冷却与总预算（见
   * `api-channel-release.ts`），但「自愈成功 → 运行仍被拒」意味着上游存在并发推进等外部变化，继续在同一个
   * 请求里循环只会把上游当重试靶子；第二次的失败回执照常返回给调用方。
   *
   * 自愈失败（冷却中、上游不可达、承载对象不是应用实体等）**不改变原始回执**：调用方拿到的仍是那枚
   * 可行动的 409，附带的原因只在日志里。
   */
  const runWithApiChannelSelfHeal = async (
    record: WorkflowRecord,
    parameters: string | null,
    isAsync: boolean,
    runtimeUserId: string | null,
  ): Promise<WorkflowRunOutcome> => {
    const input = {
      upstreamWorkflowId: record.upstreamWorkflowId,
      parameters,
      isAsync,
      runtimeUserId,
    };
    const first = await runPublishedWorkflow(input, { callUpstreamOpenApi: upstream });
    if (first.ok || first.rejection.code !== WORKFLOW_NOT_REGISTERED_CODE) return first;

    const released = await release({
      upstreamWorkflowId: record.upstreamWorkflowId,
      appId: record.appId,
    });
    if (released.status !== "released") {
      logger.warn("workflow-v2 对外触发：API 渠道自愈未完成，返回原始拒绝", {
        organizationId: record.organizationId,
        workflowId: record.id,
        releaseStatus: released.status,
      });
      // 「承载对象不是可发布的应用实体」是**永久性**前置条件缺失（历史 bot 载体，见
      // `docs/design/2026-10-09-workflow-v2-api-channel-release.md` §4）：重试永远不会好，
      // 因此换一条不含「稍后重试」暗示的文案，把可行动方向指向平台管理员。
      if (released.status === "app_not_publishable") {
        return {
          ok: false,
          rejection: {
            ...first.rejection,
            message: "工作流当前发布版本未登记到 API 渠道，且平台无法自动补登记；请联系平台管理员处理",
          },
        };
      }
      return first;
    }

    const second = await runPublishedWorkflow(input, { callUpstreamOpenApi: upstream });
    if (!second.ok) {
      logger.warn("workflow-v2 对外触发：补登记后仍被上游拒绝", {
        organizationId: record.organizationId,
        workflowId: record.id,
        version: released.version,
        rejectionCode: second.rejection.code,
      });
    }
    return second;
  };

  app.post(
    "/workflows/:id/run",
    async ({ store, params, body, status, set }) => {
      const actor = readActor(store);
      if (!actor) return status(401, UNAUTHENTICATED);

      // 限流先于一切查询：它既是配额，也是「探测 workflow 是否存在」的减速带。
      const decision = rateLimiter.tryAcquire(
        actor.userId,
        policyPerMinute(getWorkflowV2Config().apiRateLimitPerMinute),
        Date.now(),
      );
      if (!decision.allowed) {
        set.headers["retry-after"] = String(decision.retryAfterSeconds);
        return status(429, RATE_LIMITED);
      }

      const record = await findWorkflowById(actor.organizationId, params.id);
      if (!record) return status(404, NOT_FOUND);

      const parameters = normalizeRunParameters(body.parameters);
      if (!parameters.ok) return status(422, apiError("INVALID_PARAMETERS", parameters.message));

      const context = { organizationId: actor.organizationId, workflowId: record.id };
      const audit = createWorkflowAuditWriter({
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        action: WORKFLOW_AUDIT_ACTIONS.runExternal,
        upstreamWorkflowId: record.upstreamWorkflowId,
      });

      let outcome: Awaited<ReturnType<typeof runPublishedWorkflow>>;
      try {
        outcome = await runWithApiChannelSelfHeal(
          record,
          parameters.parameters,
          body.isAsync,
          body.ext?.user_id ?? null,
        );
      } catch (error) {
        // 传输/凭据/熔断失败：与控制面同一张映射表，只是换一个信封。
        const failure = upstreamFailure("对外触发运行", { thrown: error }, context);
        await audit(upstreamAuditResult(failure), failure.body.code);
        return status(failure.httpStatus, { error: failure.body });
      }

      if (!outcome.ok) {
        await audit(outcome.rejection.auditResult, outcome.rejection.code);
        return status(outcome.rejection.httpStatus, {
          error: { code: outcome.rejection.code, message: outcome.rejection.message },
        });
      }

      await audit("ok");
      return outcome.run;
    },
    {
      // 与 `/web` 面同一份守卫实例：API Key 的组织上下文由 key metadata 恢复并重新校验成员关系。
      sessionAuth: true,
      headers: RunWorkflowHeadersSchema,
      params: RunWorkflowParamsSchema,
      body: RunWorkflowBodySchema,
      response: {
        200: RunWorkflowResponseSchema,
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        422: ApiErrorResponseSchema,
        429: ApiErrorResponseSchema,
        500: ApiErrorResponseSchema,
        502: ApiErrorResponseSchema,
        503: ApiErrorResponseSchema,
        504: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["External Workflow"],
        summary: "触发工作流运行",
        description:
          "以控制台 API Key（`Authorization: Bearer rcs_*`）触发指定工作流的**已发布版本**运行：`:id` 是控制台的" +
          "工作流主键（不是上游 ID），归属按调用方所在组织判定，跨组织与不存在同形返回 404。`isAsync=false`" +
          "（默认）等待本次运行结束并返回 `data`；`isAsync=true` 立即返回 `executeId`，结果在上游调试页查看。" +
          "工作流尚未发布返回 409；上游不可用返回 502/503/504。",
      },
    },
  );

  return app;
}
