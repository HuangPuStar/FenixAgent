/**
 * 专家库配置路由 — `POST /web/config/agent-expert` action 风格（设计文档 §3）。
 *
 * actions:
 *   list      → 内置 + 本组织专家列表（默认排除 disabled，支持 includeDisabled）
 *   create    → 创建专家（name/description/prompt/skills/model/mode/temperature/steps）
 *   update    → 更新专家（system 行拒绝 FORBIDDEN）
 *   delete    → 删除专家（内置 system 行拒绝 FORBIDDEN，其软删除由模板同步管理；
 *               组织自建物理删除）
 *   refresh   → 手动触发内置模板同步（幂等，失败仅告警）
 *   duplicate → 复制专家到本组织（内置专家恢复路径，重名自动 -copy 后缀）
 *
 * 多租户：list 恒为 IN ('system', ?org)；写操作仅限本组织行；system 行只读。
 */

import Elysia from "elysia";
import * as z from "zod/v4";
import { AppError } from "../../../errors";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import { WebErrSchema } from "../../../schemas/common.schema";
import {
  AgentExpertActionBodySchema,
  AgentExpertDeleteResponseSchema,
  AgentExpertListResponseSchema,
  AgentExpertMutationResponseSchema,
  AgentExpertRefreshResponseSchema,
} from "../../../schemas/config.schema";
import { syncBuiltinExperts } from "../../../services/agent-expert-sync";
import * as expertService from "../../../services/config/agent-expert";
import { configError, configNotFound, configSuccess, configValidationError } from "../../../services/config-utils";

const app = new Elysia({ name: "web-config-agent-experts" }).use(authGuardPlugin);

/** 从 body 解析 action 分发所需字段（body 已由 schema 校验，此处仅防御性收窄） */
function parseBody(body: unknown): {
  action: string;
  name: string | undefined;
  data: Record<string, unknown> | undefined;
  includeDisabled: boolean;
} {
  const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  return {
    action: typeof raw.action === "string" ? raw.action : "",
    name: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : undefined,
    data: typeof raw.data === "object" && raw.data !== null ? (raw.data as Record<string, unknown>) : undefined,
    includeDisabled: raw.includeDisabled === true,
  };
}

/** 专家 ID 必须是 UUID（name 字段承载专家 ID，与 md 文件名无直接关系） */
function isValidExpertId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

async function handleList(ctx: AuthContext, includeDisabled: boolean) {
  const experts = await expertService.listAgentExperts(ctx, { includeDisabled });
  return configSuccess({ experts });
}

async function handleCreate(ctx: AuthContext, data: Record<string, unknown> | undefined) {
  if (!data || typeof data !== "object") {
    return configValidationError("Missing required field: data");
  }
  try {
    const expert = await expertService.createAgentExpert(ctx, data);
    return configSuccess({ expert });
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === "ALREADY_EXISTS") return configError("ALREADY_EXISTS", err.message);
      if (err.code === "VALIDATION_ERROR") return configValidationError(err.message);
    }
    throw err;
  }
}

async function handleUpdate(ctx: AuthContext, id: string, data: Record<string, unknown> | undefined) {
  if (!data || typeof data !== "object") {
    return configValidationError("Missing required field: data");
  }
  try {
    const expert = await expertService.updateAgentExpert(ctx, id, data);
    if (!expert) return configNotFound(`Expert '${id}' not found`);
    return configSuccess({ expert });
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") return configError("FORBIDDEN", err.message);
    if (err instanceof AppError && err.code === "VALIDATION_ERROR") return configValidationError(err.message);
    throw err;
  }
}

async function handleDelete(ctx: AuthContext, id: string) {
  try {
    const deleted = await expertService.deleteAgentExpert(ctx, id);
    if (!deleted) return configNotFound(`Expert '${id}' not found`);
    return configSuccess(null);
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") return configError("FORBIDDEN", err.message);
    throw err;
  }
}

/** refresh：手动触发内置模板同步。幂等；失败仅告警（syncBuiltinExperts 内部已逐文件容错） */
async function handleRefresh() {
  await syncBuiltinExperts();
  return configSuccess({ refreshed: true });
}

async function handleDuplicate(ctx: AuthContext, id: string) {
  try {
    const expert = await expertService.duplicateAgentExpert(ctx, id);
    if (!expert) return configNotFound(`Expert '${id}' not found`);
    return configSuccess({ expert });
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN") return configError("FORBIDDEN", err.message);
    throw err;
  }
}

type WebErrorBody = z.infer<typeof WebErrSchema>;

function buildWebErrorBody(code: string, message: string): WebErrorBody {
  return { success: false, error: { code, message } };
}

function isConfigErrorResult(value: unknown): value is { success: false; error: { code?: string; message?: string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    (value as { success?: unknown }).success === false &&
    "error" in value
  );
}

function mapConfigErrorStatus(code: string | undefined): number {
  switch (code) {
    case "VALIDATION_ERROR":
      return 400;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "ALREADY_EXISTS":
      return 409;
    default:
      return 400;
  }
}

function resolveConfigRouteError(result: unknown): { code: 400 | 403 | 404 | 409; body: WebErrorBody } | null {
  if (!isConfigErrorResult(result)) return null;
  return {
    code: mapConfigErrorStatus(result.error.code) as 400 | 403 | 404 | 409,
    body: buildWebErrorBody(result.error.code ?? "UNKNOWN_ERROR", result.error.message ?? "未知错误"),
  };
}

type ExpertActionResponse =
  | z.infer<typeof AgentExpertListResponseSchema>
  | z.infer<typeof AgentExpertMutationResponseSchema>
  | z.infer<typeof AgentExpertDeleteResponseSchema>
  | z.infer<typeof AgentExpertRefreshResponseSchema>
  | WebErrorBody;

app.post(
  "/config/agent-expert",
  async ({ store, body, status }) => {
    const authCtx = store.authContext!;
    const { action, name, data, includeDisabled } = parseBody(body);

    let result: unknown;
    switch (action) {
      case "list":
        result = await handleList(authCtx, includeDisabled);
        break;
      case "create":
        result = await handleCreate(authCtx, data);
        break;
      case "update":
      case "delete":
      case "duplicate": {
        if (!name || !isValidExpertId(name)) {
          result = configValidationError(`Invalid expert id for action '${action}'`);
          break;
        }
        result =
          action === "update"
            ? await handleUpdate(authCtx, name, data)
            : action === "delete"
              ? await handleDelete(authCtx, name)
              : await handleDuplicate(authCtx, name);
        break;
      }
      case "refresh":
        result = await handleRefresh();
        break;
      default:
        result = configValidationError(`Unknown action '${action}'`);
    }

    const err = resolveConfigRouteError(result);
    if (err) return status(err.code, err.body);
    return result as ExpertActionResponse;
  },
  {
    sessionAuth: true,
    body: AgentExpertActionBodySchema,
    response: {
      200: z.union([
        AgentExpertListResponseSchema,
        AgentExpertMutationResponseSchema,
        AgentExpertDeleteResponseSchema,
        AgentExpertRefreshResponseSchema,
      ]),
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
      409: WebErrSchema,
    },
    detail: {
      tags: ["AgentExpert"],
      summary: "专家库配置（action 风格）",
      description:
        "以 action 分发管理专家库：list 返回内置 + 本组织专家；create/update/delete 管理组织自建专家（内置专家只读）；" +
        "refresh 手动触发内置模板同步；duplicate 复制专家到本组织（内置专家禁用后的恢复路径）。",
    },
  },
);

export default app;
