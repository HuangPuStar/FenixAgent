/**
 * routes/api/skills.ts — 对外 Skill OpenAPI 路由。
 *
 * 遵循对外 API 规范：标准 REST 方法、稳定分页结构、统一错误格式。
 * Skill 创建接口使用 multipart/form-data 上传协议，详情和删除接口统一按 Skill 唯一 ID 访问。
 */
import Elysia from "elysia";
import * as z from "zod/v4";
import { AppError } from "../../errors";
import { type AuthContext, authGuardPlugin } from "../../plugins/auth";
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
import {
  deleteSkillById as deleteSkillService,
  getSkillById,
  importSkillDirectories,
  listSkills,
} from "../../services/skill";

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
    const authCtx = store.authContext as AuthContext;
    const { page, pageSize } = query as ApiSkillListQuery;

    try {
      const skills = await listSkills(authCtx);
      const total = skills.length;
      const start = (page - 1) * pageSize;
      const items = skills.slice(start, start + pageSize).map((skill) => ({
        id: skill.id ?? skill.resourceAccess?.resourceUid ?? "",
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

// ── GET /api/skills/:id — 获取 Skill 详情 ──

app.get(
  "/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { id } = params as ApiSkillIdParams;

    try {
      const detail = await getSkillById(authCtx, id);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Skill '${id}' not found` } });
      }
      return {
        id: detail.id ?? id,
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
      description: "按 Skill 唯一 ID 返回详情，包含 SKILL.md 正文内容。仅返回当前组织可访问的资源。",
    },
  },
);

interface UploadManifestEntry {
  skillName: string;
  relativePath: string;
}

// ── POST /api/skills — 上传创建 Skill ──

app.post(
  "/",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, request, error }: any) => {
    const authCtx = store.authContext as AuthContext;

    try {
      let formData: FormData | null;
      try {
        formData = await request.formData();
      } catch {
        formData = null;
      }
      if (!formData) {
        return error(400, { error: { code: "VALIDATION_ERROR", message: "上传表单解析失败" } });
      }

      const manifestRaw = formData.get("manifest");
      if (typeof manifestRaw !== "string") {
        return error(400, { error: { code: "VALIDATION_ERROR", message: "缺少 manifest" } });
      }

      let manifest: UploadManifestEntry[];
      try {
        const parsed = JSON.parse(manifestRaw);
        if (!Array.isArray(parsed)) throw new Error("manifest must be an array");
        manifest = parsed as UploadManifestEntry[];
      } catch {
        return error(400, { error: { code: "VALIDATION_ERROR", message: "manifest 格式无效" } });
      }

      const overwriteValue = formData.get("overwrite");
      if (overwriteValue !== null && overwriteValue !== "true" && overwriteValue !== "false") {
        return error(400, { error: { code: "VALIDATION_ERROR", message: "overwrite 参数无效" } });
      }

      const files = formData.getAll("files").filter((item: unknown): item is File => item instanceof File);
      if (manifest.length !== files.length) {
        return error(400, { error: { code: "VALIDATION_ERROR", message: "上传文件与 manifest 数量不一致" } });
      }

      const skillNames = [...new Set(manifest.map((entry) => entry.skillName))];
      if (skillNames.length !== 1) {
        return error(400, { error: { code: "VALIDATION_ERROR", message: "每次只允许导入一个 Skill" } });
      }

      const uploadFiles = await Promise.all(
        manifest.map(async (entry, index) => ({
          skillName: entry.skillName,
          relativePath: entry.relativePath,
          content: await files[index].text(),
        })),
      );

      const result = await importSkillDirectories(
        authCtx,
        uploadFiles,
        overwriteValue === "true" ? "overwrite" : undefined,
      );
      if (result.conflicts.length > 0) {
        const conflictName = result.conflicts[0]?.name ?? skillNames[0] ?? "unknown";
        return error(409, { error: { code: "CONFLICT", message: `Skill '${conflictName}' already exists` } });
      }

      const createdName = result.imported[0]?.name;
      if (!createdName) {
        return error(500, { error: { code: "INTERNAL_ERROR", message: "Skill import returned no created entry" } });
      }

      const detail = await listSkills(authCtx).then(
        (skills) => skills.find((skill) => skill.name === createdName) ?? null,
      );
      const fullDetail = detail?.id ? await getSkillById(authCtx, detail.id) : null;
      if (!detail || !fullDetail) {
        return error(500, { error: { code: "INTERNAL_ERROR", message: "Skill could not be reloaded" } });
      }

      return {
        id: fullDetail.id ?? detail.id ?? "",
        name: fullDetail.name,
        description: fullDetail.description,
        content: fullDetail.content,
        metadata: fullDetail.metadata ?? {},
        resourceAccess: fullDetail.resourceAccess,
      };
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
    const authCtx = store.authContext as AuthContext;
    const { id } = params as ApiSkillIdParams;

    try {
      const detail = await getSkillById(authCtx, id);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Skill '${id}' not found` } });
      }

      const deleted = await deleteSkillService(authCtx, id);
      if (!deleted) {
        return error(404, { error: { code: "NOT_FOUND", message: `Skill '${id}' not found` } });
      }
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
      description: "按唯一 ID 删除 Skill，同时清理 PG 元数据和文件系统内容。内置或外部只读 Skill 不可删除。",
    },
  },
);

export default app;
