/**
 * routes/api/skills.ts — 对外 Skill OpenAPI 路由。
 *
 * 遵循对外 API 规范：标准 REST 方法、稳定分页结构、统一错误格式。
 * Skill 创建接口使用 multipart/form-data 上传协议，详情和删除接口统一按 Skill 唯一 ID 访问。
 */

import type { ActorContext, IdentityDirectory } from "@fenix/platform-sdk";
import { ApiErrorResponseSchema, AppError, toResourceAccessView } from "@fenix/platform-sdk";
import { authGuardPlugin } from "@server/plugins/auth";
import Elysia from "elysia";
import type { SkillDetailView, SkillListItem } from "../../facades/skill-facade";
import { getSkillServerModule } from "../../runtime";
import {
  ApiSkillCreateBodySchema,
  ApiSkillDeleteResponseSchema,
  ApiSkillDetailSchema,
  type ApiSkillIdParams,
  ApiSkillIdParamsSchema,
  type ApiSkillListQuery,
  ApiSkillListQuerySchema,
  ApiSkillListResponseSchema,
} from "../../schemas/api-skill.schema";
import { readSkillUploadForm, type UploadFormData } from "../skill-upload-form";

/**
 * `/api/skills` 协议层（对外已发布合同）。
 *
 * 分页与计数下推到数据库的授权查询（决策 D3）：`total` 是当前主体可见资源的真实总数，列表只取当前
 * 页，不再"全量读出后内存切片"。
 *
 * `resourceAccess` 是**唯一**保留旧字段形状的位置（决策 D2）：它由 `toResourceAccessView` 从
 * `scope + access.actions` 派生，资源包不再各自解释权限。
 */

/**
 * 将业务异常映射到对外 API 的稳定错误结构。
 */
function mapApiError(err: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (err instanceof AppError) {
    return { status: err.statusCode, body: { error: { code: err.code, message: err.message } } };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Unknown error" } },
  };
}

/** 批量解析归属组织名称；名录不可用时字段整体省略。 */
async function resolveOrganizationNames(
  identity: IdentityDirectory,
  organizationIds: readonly (string | undefined)[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(organizationIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return new Map();
  return identity.listOrganizationNames(ids);
}

/** 派生已发布合同的资源访问视图；组织名称由调用方批量解析后传入。 */
function buildResourceAccess(
  skill: SkillListItem | SkillDetailView,
  activeOrganizationId: string | undefined,
  sourceOrganizationName: string | undefined,
) {
  return toResourceAccessView({
    resource: { id: skill.id, scope: skill.scope, access: skill.access },
    ...(activeOrganizationId === undefined ? {} : { activeOrganizationId }),
    ...(sourceOrganizationName === undefined ? {} : { sourceOrganizationName }),
  });
}

/** 组装对外列表项。 */
function toApiSkillListItem(
  skill: SkillListItem,
  activeOrganizationId: string | undefined,
  sourceOrganizationName: string | undefined,
) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    resourceAccess: buildResourceAccess(skill, activeOrganizationId, sourceOrganizationName),
  };
}

/** 组装对外详情。 */
function toApiSkillDetail(
  skill: SkillDetailView,
  activeOrganizationId: string | undefined,
  sourceOrganizationName: string | undefined,
) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    content: skill.content,
    metadata: skill.metadata,
    resourceAccess: buildResourceAccess(skill, activeOrganizationId, sourceOrganizationName),
  };
}

/** 对外上传协议只接受 `true` / `false` 两个字面量；其余取值是请求错误。 */
function resolveOverwrite(formData: UploadFormData): boolean {
  const value = formData.get("overwrite");
  if (value === null || value === "") return false;
  if (value !== "true" && value !== "false") {
    throw new AppError("overwrite 参数无效", "VALIDATION_ERROR", 400);
  }
  return value === "true";
}

const app = new Elysia({ name: "api-skills", prefix: "/api/skills" }).use(authGuardPlugin).model({
  "api-skill-list-query": ApiSkillListQuerySchema,
  "api-skill-id-params": ApiSkillIdParamsSchema,
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
    const actor = store.actor as ActorContext | null;
    if (!actor) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    }
    const { page, pageSize } = query as ApiSkillListQuery;

    try {
      const { facade, identity } = getSkillServerModule();
      const { items, total } = await facade.list(actor, { limit: pageSize, offset: (page - 1) * pageSize });
      const organizationNames = await resolveOrganizationNames(
        identity,
        items.map((item) => item.scope.organizationId),
      );
      return {
        items: items.map((item) =>
          toApiSkillListItem(item, actor.activeOrganizationId, organizationNames.get(item.scope.organizationId ?? "")),
        ),
        total,
        page,
        pageSize,
      };
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
        "返回当前主体可见的 Skill 列表（不含正文内容），采用稳定分页结构；分页与计数在数据库内完成。包含组织内部创建的 Skill 以及外部组织公开的只读 Skill。",
    },
  },
);

// ── GET /api/skills/:id — 获取 Skill 详情 ──

app.get(
  "/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, error }: any) => {
    const actor = store.actor as ActorContext | null;
    if (!actor) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    }
    const { id } = params as ApiSkillIdParams;

    try {
      const { facade, identity } = getSkillServerModule();
      const detail = await facade.readDetailById(actor, id);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Skill '${id}' not found` } });
      }
      const organizationNames = await resolveOrganizationNames(identity, [detail.scope.organizationId]);
      return toApiSkillDetail(
        detail,
        actor.activeOrganizationId,
        organizationNames.get(detail.scope.organizationId ?? ""),
      );
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-skill-id-params",
    response: {
      200: "api-skill-detail",
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Skill"],
      summary: "获取 Skill 详情",
      description: "按 Skill 唯一 ID 返回详情，包含 SKILL.md 正文内容。仅返回当前主体可见的资源。",
    },
  },
);

// ── POST /api/skills — 上传创建 Skill ──

app.post(
  "/",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, request, error }: any) => {
    const actor = store.actor as ActorContext | null;
    if (!actor) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    }

    try {
      const { facade, identity } = getSkillServerModule();
      const { files, formData } = await readSkillUploadForm(request);
      const overwrite = resolveOverwrite(formData);

      const skillNames = [...new Set(files.map((file) => file.skillName))];
      if (skillNames.length !== 1) {
        throw new AppError("每次只允许导入一个 Skill", "VALIDATION_ERROR", 400);
      }

      const result = await facade.importDirectories(actor, files, overwrite ? "overwrite" : undefined);
      if (result.conflicts.length > 0) {
        const conflictName = result.conflicts[0]?.name ?? skillNames[0] ?? "unknown";
        return error(409, { error: { code: "CONFLICT", message: `Skill '${conflictName}' already exists` } });
      }

      const imported = result.imported[0];
      if (!imported) {
        return error(500, { error: { code: "INTERNAL_ERROR", message: "Skill import returned no created entry" } });
      }
      const detail = await facade.readDetailById(actor, imported.id);
      if (!detail) {
        return error(500, { error: { code: "INTERNAL_ERROR", message: "Skill could not be reloaded" } });
      }
      const organizationNames = await resolveOrganizationNames(identity, [detail.scope.organizationId]);
      return toApiSkillDetail(
        detail,
        actor.activeOrganizationId,
        organizationNames.get(detail.scope.organizationId ?? ""),
      );
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    response: {
      200: "api-skill-detail",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      409: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External Skill"],
      summary: "上传创建 Skill",
      description:
        "使用与控制台上传接口一致的 multipart/form-data 协议导入单个 Skill。表单需要包含 `manifest` JSON 字符串和 `files` 文件列表；传 `overwrite=true` 时允许覆盖同名 Skill，否则同名冲突返回 409。",
    },
  },
);

// ── DELETE /api/skills/:id — 删除 Skill ──

app.delete(
  "/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, error }: any) => {
    const actor = store.actor as ActorContext | null;
    if (!actor) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    }
    const { id } = params as ApiSkillIdParams;

    try {
      const { facade } = getSkillServerModule();
      const detail = await facade.getById(actor, id);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Skill '${id}' not found` } });
      }
      await facade.removeById(actor, id);
      return { id, name: detail.name, deleted: true as const };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-skill-id-params",
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
      description: "按唯一 ID 删除 Skill，同时清理数据库元数据和文件系统内容。仅可删除当前主体有权删除的 Skill。",
    },
  },
);

export default app;
