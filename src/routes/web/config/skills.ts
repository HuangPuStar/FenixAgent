import Elysia from "elysia";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import { type ConfigBody, ConfigBodySchema } from "../../../schemas/config.schema";
import { configError, configNotFound, configSuccess, configValidationError } from "../../../services/config-utils";
import {
  deleteSkill,
  getSkill,
  type ImportConflictStrategy,
  importSkillDirectories,
  listSkills,
  setSkill,
} from "../../../services/skill";

const app = new Elysia({ name: "web-config-skills" }).use(authGuardPlugin).model({
  "config-body": ConfigBodySchema,
});

async function handleList(ctx: AuthContext) {
  const skills = await listSkills(ctx);
  return configSuccess({ skills });
}

async function handleGet(
  ctx: AuthContext,
  body: { name?: string },
  errorFn: (status: number, body: unknown) => unknown,
) {
  if (!body.name) {
    return errorFn(400, configValidationError("Missing 'name' field"));
  }
  const skill = await getSkill(ctx, body.name);
  if (!skill) {
    return errorFn(404, configNotFound(`Skill '${body.name}' not found`));
  }
  return configSuccess(skill);
}

async function handleSet(
  ctx: AuthContext,
  body: {
    name?: string;
    data?: { description: string; content: string; metadata?: Record<string, string>; publicReadable?: boolean };
  },
  errorFn: (status: number, body: unknown) => unknown,
) {
  if (!body.name) {
    return errorFn(400, configValidationError("Missing 'name' field"));
  }
  if (!body.data?.content) {
    return errorFn(400, configValidationError("Missing required field: data.content"));
  }
  const result = await setSkill(ctx, body.name, body.data);
  return configSuccess({ name: result.name, resourceAccess: result.resourceAccess });
}

async function handleDelete(
  ctx: AuthContext,
  body: { name?: string },
  errorFn: (status: number, body: unknown) => unknown,
) {
  if (!body.name) {
    return errorFn(400, configValidationError("Missing 'name' field"));
  }
  const deleted = await deleteSkill(ctx, body.name);
  if (!deleted) {
    return errorFn(404, configNotFound(`Skill '${body.name}' not found`));
  }
  return configSuccess(null);
}

interface UploadManifestEntry {
  skillName: string;
  relativePath: string;
}

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

app.post(
  "/config/skills",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const b = (body as ConfigBody) ?? {};
    const payload = {
      action: b.action ?? "",
      name: b.name,
      data: b.data as
        | { description: string; content: string; metadata?: Record<string, string>; publicReadable?: boolean }
        | undefined,
    };
    const { action } = payload;

    const errFn = (status: number, data: unknown) => error(status, data);

    switch (action) {
      case "list":
        return await handleList(authCtx);
      case "get":
        return await handleGet(authCtx, payload, errFn);
      case "set":
        return await handleSet(authCtx, payload, errFn);
      case "delete":
        return await handleDelete(authCtx, payload, errFn);
      default:
        return error(400, configValidationError(`Unknown action: ${action}`));
    }
  },
  { sessionAuth: true, body: "config-body", detail: { tags: ["SkillConfig"], summary: "Skill 配置管理" } },
);

app.post(
  "/config/skills/upload",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
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
