/**
 * routes/api/skills.ts — 对外 Skill OpenAPI 路由。
 *
 * 遵循对外 API 规范：标准 REST 方法、稳定分页结构、统一错误格式、向后兼容。
 */
import Elysia from "elysia";
import * as z from "zod/v4";
import { AppError } from "../../errors";
import { type AuthContext, authGuardPlugin } from "../../plugins/auth";
import {
  type ApiSkillCreateBody,
  ApiSkillCreateBodySchema,
  ApiSkillDeleteResponseSchema,
  ApiSkillDetailSchema,
  type ApiSkillListQuery,
  ApiSkillListQuerySchema,
  ApiSkillListResponseSchema,
  type ApiSkillNameParams,
  ApiSkillNameParamsSchema,
} from "../../schemas/api-skill.schema";
import { deleteSkill as deleteSkillService, getSkill, listSkills, setSkill } from "../../services/skill";

const ApiErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().describe("错误码。"),
      message: z.string().describe("错误描述。"),
    }),
  })
  .describe("统一错误响应。");

/**
 * 将业务异常映射到对外 API 的稳定错误结构。
 */
function mapApiError(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  // 校验类错误（skill 名称不合法等）
  if (error instanceof Error && "code" in error && error.code === "VALIDATION_ERROR") {
    return {
      status: 400,
      body: { error: { code: "VALIDATION_ERROR", message: error.message } },
    };
  }
  if (error instanceof AppError) {
    return {
      status: error.statusCode,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unknown error" } },
  };
}

const app = new Elysia({ name: "api-skills", prefix: "/api/skills" }).use(authGuardPlugin).model({
  "api-skill-list-query": ApiSkillListQuerySchema,
  "api-skill-name-params": ApiSkillNameParamsSchema,
  "api-skill-create-body": ApiSkillCreateBodySchema,
  "api-skill-list-response": ApiSkillListResponseSchema,
  "api-skill-detail": ApiSkillDetailSchema,
  "api-skill-delete-response": ApiSkillDeleteResponseSchema,
});

// ── GET /api/skills — 获取 Skill 列表 ──

app.get(
  "/",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, query, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { page, pageSize } = query as ApiSkillListQuery;

    try {
      const skills = await listSkills(authCtx);
      const total = skills.length;
      const start = (page - 1) * pageSize;
      const items = skills.slice(start, start + pageSize).map((skill) => ({
        name: skill.name,
        description: skill.description,
        resourceAccess: skill.resourceAccess,
      }));
      return { items, total, page, pageSize };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    query: "api-skill-list-query",
    response: {
      200: "api-skill-list-response",
      401: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Skill"],
      summary: "获取 Skill 列表",
      description:
        "返回当前组织可访问的 Skill 列表（不含正文内容），采用稳定分页结构。包含组织内部创建的 Skill 以及外部组织共享的只读 Skill。",
    },
  },
);

// ── GET /api/skills/:name — 获取 Skill 详情 ──

app.get(
  "/:name",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { name } = params as ApiSkillNameParams;

    try {
      const detail = await getSkill(authCtx, name);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Skill '${name}' not found` } });
      }
      return {
        name: detail.name,
        description: detail.description,
        content: detail.content,
        metadata: detail.metadata ?? {},
        resourceAccess: detail.resourceAccess,
      };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-skill-name-params",
    response: {
      200: "api-skill-detail",
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Skill"],
      summary: "获取 Skill 详情",
      description: "按 Skill 名称返回详情，包含 SKILL.md 正文内容。仅返回当前组织可访问的资源。",
    },
  },
);

// ── POST /api/skills — 创建或替换 Skill（upsert）──

app.post(
  "/",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const payload = body as ApiSkillCreateBody;

    try {
      // upsert：存在就覆盖，不存在就创建（PG 元数据 + 文件系统 SKILL.md 双同步）
      const result = await setSkill(authCtx, payload.name, {
        description: payload.description ?? "",
        content: payload.content,
        metadata: payload.metadata ?? undefined,
      });

      const detail = await getSkill(authCtx, result.name);
      if (!detail) {
        return error(500, { error: { code: "INTERNAL_ERROR", message: "Skill could not be reloaded" } });
      }
      return {
        name: detail.name,
        description: detail.description,
        content: detail.content,
        metadata: detail.metadata ?? {},
        resourceAccess: detail.resourceAccess,
      };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    body: "api-skill-create-body",
    response: {
      200: "api-skill-detail",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Skill"],
      summary: "创建或替换 Skill",
      description:
        "创建或替换 Skill。名称已存在时覆盖，不存在时新建。写入 PG 元数据并同步 SKILL.md 到文件系统。外部只读 Skill 不可写入。",
    },
  },
);

// ── DELETE /api/skills/:name — 删除 Skill ──

app.delete(
  "/:name",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { name } = params as ApiSkillNameParams;

    try {
      const deleted = await deleteSkillService(authCtx, name);
      if (!deleted) {
        return error(404, { error: { code: "NOT_FOUND", message: `Skill '${name}' not found` } });
      }
      return { name, deleted: true as const };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-skill-name-params",
    response: {
      200: "api-skill-delete-response",
      401: ApiErrorResponseSchema,
      403: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Skill"],
      summary: "删除 Skill",
      description: "按名称删除 Skill，同时清理 PG 元数据和文件系统内容。内置或外部只读 Skill 不可删除。",
    },
  },
);

export default app;
