import { createLogger } from "@fenix/logger";
import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import { Elysia } from "elysia";
import * as z from "zod/v4";
import {
  ensurePlatformAccountWithinBudget,
  findPlatformAccount,
  type PlatformAccountSnapshot,
} from "../../services/platform-account-bootstrap";
import {
  getUpstreamSession,
  getUpstreamSessionStatus,
  UpstreamSessionUnavailableError,
} from "../../services/upstream-session";
import type { WorkflowV2RouteDependencies } from "../dependencies";

/**
 * `/web/workflow-v2/platform-account` — 平台上游账号的只读状态与管理员重登（设计 §4.3）。
 *
 * 数据面：**平台级、无租户归属**——整个 FenixAgent 只映射上游的一个用户（设计 §3.1），因此这里没有
 * 组织谓词可用，也不做组织过滤；边界就是「会话守卫已认证」。这与其余 `/web/workflow-v2/*`（按
 * `activeOrganizationId` 隔离）的差别是领域事实，不是遗漏。
 *
 * 凭据边界：响应只含状态与时效（就绪、上次登录/探活时间、到期时间、失败标签），**绝不返回会话值、
 * 邮箱或密码**；会话材料连本文件都不接触（在 `upstream-session` 的内存里）。
 *
 * 空间来源：`spaceId` 读本包平台账号台账（`workflow_v2_platform_account`，经 `findPlatformAccount()`）；
 * 台账无行（尚未引导账号）是合法状态，如实回 null（画布页据此判定 `space-missing`）。**读库失败不降级成
 * null**，而是回 500——理由见 handler 内注释。
 *
 * 已知缺口（需后续任务收口，不在本文件能力范围内）：
 * - `platformUserId` 仍只回登录响应回显的 user id，其权威值同在 `workflow_v2_platform_account` 行（owner：
 *   2B 的 repository）；与 `spaceId` 同源后应一并改为从台账投影；
 * - 角色判定：冻结的 `WorkflowV2ActorContext` 只带 `organizationId` / `userId`，本层拿不到 role，
 *   因此重登接口当前只要求已认证会话，尚未收窄到系统管理员（设计 §4.3 的目标口径）。
 */

const logger = createLogger("wf2-platform-account-route");

/** 台账读失败的对外错误；文案为我方固定文案，不含错误原文、SQL 细节与凭据。 */
const ACCOUNT_READ_FAILURE = { code: "INTERNAL_ERROR", message: "本地账号台账读取失败" } as const;

/** 平台账号状态；字段与设计 §4.3 的行一致，另补会话时效字段（不含凭据）。 */
const PlatformAccountStatusSchema = z.object({
  platformUserId: z.string().nullable().describe("上游用户 ID；进程未登录过时为 null，权威值在平台账号表。"),
  spaceId: z
    .string()
    .nullable()
    .describe("上游个人空间 ID；取自平台账号台账 `workflow_v2_platform_account`，尚未引导账号时为 null。"),
  status: z.enum(["active", "degraded"]).describe("active=进程持有可用会话；degraded=需要重登或上游不可用。"),
  lastLoginAt: z.string().nullable().describe("上次登录成功时间（ISO 8601）；仅进程内记忆，重启后为 null。"),
  expiresAt: z.string().nullable().describe("上游声明的会话到期时间（ISO 8601）；未声明时为 null。"),
  lastProbeAt: z.string().nullable().describe("上次探活时间（ISO 8601）；从未探活为 null。"),
  lastProbeOk: z.boolean().nullable().describe("上次探活结果；从未探活为 null。"),
  lastErrorCode: z.string().nullable().describe("最近一次会话失败的原因标签（不含凭据）。"),
});

const PlatformAccountStatusResponseSchema = WebOkSchema(PlatformAccountStatusSchema).describe("平台账号状态响应。");

/** 重登请求体：`reason` 只作运维说明，会话逻辑不依赖它；整体可选——运维用裸 `curl -X POST` 触发是常见形态。 */
const PlatformAccountLoginBodySchema = z
  .object({
    reason: z.string().max(200).optional().describe("触发重登的原因说明（仅记录用）。"),
  })
  .optional();

const PlatformAccountLoginResponseSchema = WebOkSchema(
  z.object({
    status: z.enum(["active", "degraded"]).describe("重登后的会话状态。"),
  }),
).describe("平台账号重登响应。");

/**
 * `/web/workflow-v2/platform-account` 路由工厂。
 *
 * 读接口**只在台账缺行时**发一次上游请求（按需引导平台账号，见下）；台账已有行时是纯本地读 + 不出站，
 * 探活仍由健康检查或运维显式触发。重登接口先 `invalidate()` 再 `ensureCookie()`，因此「触发重登」是
 * 确定行为，不受当前内存态影响。
 */
export function createWebWorkflowV2PlatformAccountRoutes(deps: WorkflowV2RouteDependencies) {
  const app = new Elysia({ name: "web-workflow-v2-platform-account" }).use(deps.authGuardPlugin);

  app.get(
    "/platform-account",
    async ({ status }) => {
      const session = getUpstreamSessionStatus();
      let account: PlatformAccountSnapshot | null;
      try {
        // 只读台账，不出站（探活由健康检查或运维显式触发）。
        account = await findPlatformAccount();
      } catch (error) {
        // 读库失败必须显式失败，不能降级成 `spaceId: null`：那会让「DB 不可用」与「尚未引导账号」在画布页上
        // 表现成同一个 `space-missing` 死局，排障时分不清是哪一种。500 而非 503 —— 失败发生在我方读路径，
        // 不是上游不可用。对外只给固定文案；诊断上下文（错误消息，不含凭据、邮箱、会话值或 SQL 细节）只进日志。
        logger.error("workflow-v2 平台账号台账读取失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        return status(500, { success: false as const, error: ACCOUNT_READ_FAILURE });
      }
      // 台账缺行 = 画布页拿不到 `space_id`（`space-missing` 死局），因此这里按需引导一次：单飞、8s 预算、
      // 失败/超时都降级成 null（画布页仍有重试，前端另有有界自动重试）。已有行时零额外成本，不触发出站。
      if (account === null) {
        account = await ensurePlatformAccountWithinBudget();
        if (account === null) logger.warn("workflow-v2 平台账号尚未就绪，本次读请求降级为未就绪");
      }
      return {
        success: true as const,
        data: {
          platformUserId: session.platformUserId,
          // 空间只认台账；无行（尚未引导）时如实回 null，由画布页判定 space-missing，本层不臆造。
          spaceId: account?.platformSpaceId ?? null,
          status: session.ready ? ("active" as const) : ("degraded" as const),
          lastLoginAt: session.lastLoginAt,
          expiresAt: session.expiresAt,
          lastProbeAt: session.lastProbeAt,
          lastProbeOk: session.lastProbeOk,
          lastErrorCode: session.lastErrorCode,
        },
      };
    },
    {
      sessionAuth: true,
      response: { 200: PlatformAccountStatusResponseSchema, 500: WebErrSchema },
      detail: {
        tags: ["Workflow V2"],
        summary: "读取平台上游账号状态",
        description:
          "返回 { platformUserId, spaceId, status, lastLoginAt, expiresAt, lastProbeAt, lastProbeOk, lastErrorCode }；" +
          "spaceId 取自平台账号台账，尚未引导账号时为 null；不含凭据，且不触发上游请求。台账读取失败时返回 500。",
      },
    },
  );

  app.post(
    "/platform-account/login",
    async ({ status }) => {
      // 请求体的 `reason` 只作运维说明：不进日志正文（自由文本不宜写日志），也不影响会话逻辑。
      const session = getUpstreamSession();
      session.invalidate();
      try {
        await session.ensureCookie();
        return { success: true as const, data: { status: "active" as const } };
      } catch (error) {
        const reason = error instanceof UpstreamSessionUnavailableError ? error.reason : "unknown";
        // 失败原因标签只含状态码/业务码，不含凭据；上游响应原文与凭据一律不回传。
        return status(503, {
          success: false as const,
          error: {
            code: "PLATFORM_SESSION_UNAVAILABLE",
            message: `平台工作流账号登录失败（${reason}）`,
          },
        });
      }
    },
    {
      sessionAuth: true,
      body: PlatformAccountLoginBodySchema,
      response: { 200: PlatformAccountLoginResponseSchema, 503: WebErrSchema },
      detail: {
        tags: ["Workflow V2"],
        summary: "触发平台上游账号重登",
        description: "请求体 { reason? }，返回 { status }；丢弃当前会话并立即重新登录，失败时返回 503。",
      },
    },
  );

  return app;
}
