/**
 * Skill 配置路由 — RESTful 风格
 *
 * 提供 Skill 的完整 CRUD 操作，包括创建、读取、更新、删除和批量上传。
 *
 * GET    /config/skills        → 列出所有 Skill（当前组织可见）
 * GET    /config/skills/:name  → 获取单个 Skill 详情
 * POST   /config/skills        → 创建新 Skill
 * PUT    /config/skills/:name  → 更新已有 Skill
 * DELETE /config/skills/:name  → 删除 Skill
 * POST   /config/skills/upload → 批量上传技能目录（multipart/form-data）
 */

import Elysia from "elysia";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import { configError, configNotFound, configSuccess, configValidationError } from "../../../services/config-utils";
import {
  deleteSkill,
  getSkill,
  type ImportConflictStrategy,
  importSkillDirectories,
  listSkills,
  setSkill,
} from "../../../services/skill";

const app = new Elysia({ name: "web-config-skills" }).use(authGuardPlugin);

// ── 请求体类型 ──

interface CreateSkillBody {
  name?: string;
  data?: {
    description: string;
    content: string;
    metadata?: Record<string, string>;
    publicReadable?: boolean;
  };
}

interface UpdateSkillBody {
  data?: {
    description: string;
    content: string;
    metadata?: Record<string, string>;
    publicReadable?: boolean;
  };
}

interface UploadManifestEntry {
  skillName: string;
  relativePath: string;
}

// ── Handler 函数 ──

/**
 * 列出当前组织可见的所有 Skill。
 */
async function handleList(ctx: AuthContext) {
  const skills = await listSkills(ctx);
  return configSuccess({ skills });
}

/**
 * 获取单个 Skill 的完整详情。
 */
async function handleGet(ctx: AuthContext, name: string) {
  if (!name) {
    return configValidationError("Missing 'name' field");
  }
  const skill = await getSkill(ctx, name);
  if (!skill) {
    return configNotFound(`Skill '${name}' not found`);
  }
  return configSuccess(skill);
}

/**
 * 创建新 Skill。
 * 如果同名 Skill 已存在且属于当前组织（非共享），拒绝创建。
 */
async function handleCreate(
  ctx: AuthContext,
  body: CreateSkillBody,
  errorFn: (status: number, body: unknown) => unknown,
) {
  if (!body.name) {
    return errorFn(400, configValidationError("Missing 'name' field"));
  }
  if (!body.data?.content) {
    return errorFn(400, configValidationError("Missing required field: data.content"));
  }

  // 检查同名非共享 Skill 是否已存在
  const existing = await getSkill(ctx, body.name);
  if (existing && existing.resourceAccess?.ownership === "internal") {
    return errorFn(409, configError("CONFLICT", `Skill '${body.name}' already exists`));
  }

  const result = await setSkill(ctx, body.name, body.data);
  return configSuccess({ name: result.name, resourceAccess: result.resourceAccess });
}

/**
 * 更新已有 Skill。
 */
async function handleUpdate(
  ctx: AuthContext,
  name: string,
  data: UpdateSkillBody["data"],
  errorFn: (status: number, body: unknown) => unknown,
) {
  if (!data?.content) {
    return errorFn(400, configValidationError("Missing required field: data.content"));
  }
  const result = await setSkill(ctx, name, data);
  return configSuccess({ name: result.name, resourceAccess: result.resourceAccess });
}

/**
 * 删除指定 Skill。
 */
async function handleDelete(ctx: AuthContext, name: string) {
  if (!name) {
    return configValidationError("Missing 'name' field");
  }
  const deleted = await deleteSkill(ctx, name);
  if (!deleted) {
    return configNotFound(`Skill '${name}' not found`);
  }
  return configSuccess(null);
}

/**
 * 批量上传技能目录（接收 multipart/form-data）。
 */
async function handleUpload(ctx: AuthContext, request: Request, errorFn: (status: number, body: unknown) => unknown) {
  let formData: globalThis.FormData | null;
  try {
    formData = (await request.formData()) as globalThis.FormData;
  } catch {
    formData = null;
  }
  if (!formData) {
    return errorFn(400, configValidationError("上传表单解析失败"));
  }

  const manifestRaw = formData.get("manifest");
  if (typeof manifestRaw !== "string") {
    return errorFn(400, configValidationError("缺少 manifest"));
  }

  let manifest: UploadManifestEntry[];
  try {
    const parsed = JSON.parse(manifestRaw);
    if (!Array.isArray(parsed)) {
      throw new Error("manifest must be an array");
    }
    manifest = parsed;
  } catch {
    return errorFn(400, configValidationError("manifest 格式无效"));
  }

  const conflictStrategyValue = formData.get("conflictStrategy");
  let conflictStrategy: ImportConflictStrategy | undefined;
  if (typeof conflictStrategyValue === "string" && conflictStrategyValue) {
    if (conflictStrategyValue !== "ignore" && conflictStrategyValue !== "overwrite") {
      return errorFn(400, configValidationError("冲突策略无效"));
    }
    conflictStrategy = conflictStrategyValue;
  }

  const files = formData.getAll("files").filter((item: unknown): item is File => item instanceof File);
  if (manifest.length !== files.length) {
    return errorFn(400, configValidationError("上传文件与 manifest 数量不一致"));
  }

  try {
    const uploadFiles = await Promise.all(
      manifest.map(async (entry, index) => ({
        skillName: entry.skillName,
        relativePath: entry.relativePath,
        content: await files[index].text(),
      })),
    );

    const result = await importSkillDirectories(ctx, uploadFiles, conflictStrategy);
    if (result.conflicts.length > 0) {
      return errorFn(
        409,
        configError("SKILL_CONFLICT", "检测到同名技能冲突", {
          conflicts: result.conflicts,
          allowedStrategies: ["ignore", "overwrite"],
        }),
      );
    }
    return configSuccess(result);
  } catch (error_) {
    const code =
      error_ instanceof Error && "code" in error_ && typeof error_.code === "string" ? error_.code : "UNKNOWN_ERROR";
    const message = error_ instanceof Error ? error_.message : "技能导入失败";
    const status = code === "VALIDATION_ERROR" ? 400 : 500;
    return errorFn(status, configError(code, message));
  }
}

// ── 路由注册 ──

/** 列出所有 Skill（GET /config/skills） */
app.get(
  "/config/skills",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store }: any) => {
    const authCtx = store.authContext!;
    return await handleList(authCtx);
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["SkillConfig"],
      summary: "列出所有 Skill",
      description: "返回当前组织可见的所有 Skill 列表，包括名称、描述和资源访问信息。",
    },
  },
);

/** 获取单个 Skill 详情（GET /config/skills/:name） */
app.get(
  "/config/skills/:name",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    const name = params.name as string;
    const result = await handleGet(authCtx, name);
    // handleGet 返回的不是 Elysia error() 调用结果时，直接返回
    if (
      result &&
      typeof result === "object" &&
      "success" in result &&
      (result as Record<string, unknown>).success === false
    ) {
      const errResult = result as { error?: { type?: string; message?: string } };
      return error(404, errResult.error ?? { type: "NOT_FOUND", message: `Skill '${name}' not found` });
    }
    return result;
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["SkillConfig"],
      summary: "获取单个 Skill 详情",
      description: "根据 Skill 名称获取其完整配置详情，包括描述、内容、元数据和资源访问信息。",
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          description: "Skill 名称。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

/** 创建新 Skill（POST /config/skills） */
app.post(
  "/config/skills",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    return await handleCreate(authCtx, (body ?? {}) as CreateSkillBody, (status, data) => error(status, data));
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["SkillConfig"],
      summary: "创建新 Skill",
      description: "创建一个新的 Skill 配置。如果当前组织下已有同名内部 Skill（不含共享），返回 409 CONFLICT。",
    },
  },
);

/** 更新已有 Skill（PUT /config/skills/:name） */
app.put(
  "/config/skills/:name",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const name = params.name as string;
    const data = (body as UpdateSkillBody)?.data;
    return await handleUpdate(authCtx, name, data, (status, result) => error(status, result));
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["SkillConfig"],
      summary: "更新已有 Skill",
      description: "更新指定 Skill 的配置内容、描述、元数据和公开可读性。",
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          description: "要更新的 Skill 名称。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

/** 删除 Skill（DELETE /config/skills/:name） */
app.delete(
  "/config/skills/:name",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    const name = params.name as string;
    const result = await handleDelete(authCtx, name);
    if (
      result &&
      typeof result === "object" &&
      "success" in result &&
      (result as Record<string, unknown>).success === false
    ) {
      const errResult = result as { error?: { type?: string; message?: string } };
      return error(404, errResult.error ?? { type: "NOT_FOUND", message: `Skill '${name}' not found` });
    }
    return result;
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["SkillConfig"],
      summary: "删除 Skill",
      description: "删除指定的 Skill 配置及其文件系统中的内容。",
      parameters: [
        {
          name: "name",
          in: "path",
          required: true,
          description: "要删除的 Skill 名称。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

/** 批量上传技能目录（POST /config/skills/upload） */
app.post(
  "/config/skills/upload",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型限制
  async ({ store, request, error }: any) => {
    const authCtx = store.authContext!;
    return await handleUpload(authCtx, request, (status, data) => error(status, data));
  },
  {
    sessionAuth: true,
    detail: {
      hide: true,
      tags: ["SkillConfig"],
      summary: "批量上传技能目录",
      description:
        "内部使用的技能目录导入接口，接收 `multipart/form-data` 表单、manifest 与文件内容，并按冲突策略批量导入技能。该接口主要服务于控制台内部导入流程，默认不在公开文档中展示。",
    },
  },
);

export default app;
