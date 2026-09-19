/**
 * Skill 配置路由 — RESTful 风格
 *
 * 提供 Skill 的完整 CRUD 操作，包括创建、读取、更新、删除和批量上传。
 *
 * GET    /config/skills        → 列出所有 Skill（当前主体可见）
 * GET    /config/skills/:name  → 获取单个 Skill 详情
 * POST   /config/skills        → 创建新 Skill
 * PUT    /config/skills/:name  → 更新已有 Skill
 * PUT    /config/skills/:name/access → 只更新公开受众
 * DELETE /config/skills/:name  → 删除 Skill
 * POST   /config/skills/upload → 批量上传技能目录（multipart/form-data）
 */

import type { ActorContext } from "@fenix/platform-sdk";
import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import { NotFoundError, ValidationError } from "@server/errors";
import { authGuardPlugin } from "@server/plugins/auth";
import Elysia from "elysia";
import * as z from "zod/v4";
import { getSkillServerModule } from "../../../runtime";
import { type ImportConflictStrategy, skillSourceDir } from "../../../services/skill-content";
import { createSkillArchiveBuffer } from "../../../services/skill-fs";
import { readSkillUploadForm, type UploadFormData } from "../../skill-upload-form";
import {
  buildSkillConflictBody,
  isWebSuccess,
  resolveOrganizationNames,
  runWebHandler,
  SkillUploadConflictSchema,
  toWebSkillDetail,
  toWebSkillItem,
  toWebSkillSaveResult,
  type WebHandlerResult,
} from "./skill-route-support";

/**
 * `/web/config/skills` 协议层。
 *
 * 只做协议接入：请求体校验、把请求映射为应用调用、把结果映射为 `/web` 视图。授权、可见性与名称解析
 * 全部在 Facade 内完成，本文件不判断组织、角色或 `visibility`。
 *
 * 视图变化（决策 D2）：列表与详情不再返回旧栈的 `resourceAccess`，改为返回资源归属 `scope` 与当前
 * 主体有效动作 `access.actions`；`organizationName` 是展示字段，由身份目录批量解析。
 */

// ── 请求体类型 ──

interface SkillWriteBody {
  data?: {
    description: string;
    content: string;
    metadata?: Record<string, string>;
    publicReadable?: boolean;
  };
}

interface CreateSkillBody extends SkillWriteBody {
  name?: string;
}

interface UpdateSkillAccessBody {
  publicReadable?: boolean;
}

// ── Handler 函数 ──

/** 列出当前主体可见的所有 Skill。 */
async function handleList(actor: ActorContext): Promise<WebHandlerResult> {
  const { facade, identity } = getSkillServerModule();
  const { items } = await facade.list(actor);
  const organizationNames = await resolveOrganizationNames(
    identity,
    items.map((item) => item.scope.organizationId),
  );
  return {
    success: true,
    data: {
      skills: items.map((item) => toWebSkillItem(item, organizationNames.get(item.scope.organizationId ?? ""))),
    },
  };
}

/** 获取单个 Skill 的完整详情（含 SKILL.md 正文）。 */
async function handleGet(actor: ActorContext, nameOrKey: string): Promise<WebHandlerResult> {
  const { facade, identity } = getSkillServerModule();
  const detail = await facade.readDetail(actor, nameOrKey);
  if (!detail) throw new NotFoundError(`Skill '${nameOrKey}' not found`);
  const organizationNames = await resolveOrganizationNames(identity, [detail.scope.organizationId]);
  return {
    success: true,
    data: toWebSkillDetail(detail, organizationNames.get(detail.scope.organizationId ?? "")),
  };
}

/**
 * 创建新 Skill。
 *
 * 同组织同名由 Facade 内的唯一索引判定（返回 409），本层不再预检：预检与写入之间存在竞态窗口，
 * 且跨组织公开的同名 Skill 不属于本组织，不应被判成冲突。
 */
async function handleCreate(actor: ActorContext, body: CreateSkillBody | undefined): Promise<WebHandlerResult> {
  const { identity } = getSkillServerModule();
  const name = body?.name;
  if (!name) throw new ValidationError("Missing 'name' field");
  const data = body?.data;
  if (!data?.content) throw new ValidationError("Missing required field: data.content");

  const skill = await getSkillServerModule().facade.create(actor, {
    name,
    data: {
      description: data.description ?? "",
      content: data.content,
      ...(data.metadata === undefined ? {} : { metadata: data.metadata }),
    },
    ...(data.publicReadable === undefined ? {} : { publicReadable: data.publicReadable }),
  });
  const organizationNames = await resolveOrganizationNames(identity, [skill.scope.organizationId]);
  return {
    success: true,
    data: toWebSkillSaveResult(skill, organizationNames.get(skill.scope.organizationId ?? "")),
  };
}

/** 更新已有 Skill；公开受众请使用独立的 access 接口。 */
async function handleUpdate(
  actor: ActorContext,
  nameOrKey: string,
  body: SkillWriteBody | undefined,
): Promise<WebHandlerResult> {
  const { identity } = getSkillServerModule();
  const data = body?.data;
  if (!data?.content) throw new ValidationError("Missing required field: data.content");

  const skill = await getSkillServerModule().facade.update(
    actor,
    nameOrKey,
    {
      description: data.description ?? "",
      content: data.content,
      ...(data.metadata === undefined ? {} : { metadata: data.metadata }),
    },
    { ...(data.publicReadable === undefined ? {} : { publicReadable: data.publicReadable }) },
  );
  const organizationNames = await resolveOrganizationNames(identity, [skill.scope.organizationId]);
  return {
    success: true,
    data: toWebSkillSaveResult(skill, organizationNames.get(skill.scope.organizationId ?? "")),
  };
}

/** 仅更新 Skill 的公开受众，不触碰 SKILL.md。 */
async function handleUpdateAccess(
  actor: ActorContext,
  nameOrKey: string,
  body: UpdateSkillAccessBody | undefined,
): Promise<WebHandlerResult> {
  const { identity } = getSkillServerModule();
  if (typeof body?.publicReadable !== "boolean") {
    throw new ValidationError("Missing required field: publicReadable");
  }
  const skill = await getSkillServerModule().facade.setPublicReadable(actor, nameOrKey, body.publicReadable);
  const organizationNames = await resolveOrganizationNames(identity, [skill.scope.organizationId]);
  return {
    success: true,
    data: toWebSkillSaveResult(skill, organizationNames.get(skill.scope.organizationId ?? "")),
  };
}

/** 删除指定 Skill（资源行与文件内容）。 */
async function handleDelete(actor: ActorContext, nameOrKey: string): Promise<WebHandlerResult> {
  await getSkillServerModule().facade.remove(actor, nameOrKey);
  return { success: true, data: null };
}

/** 为当前主体可读 Skill 生成带顶层目录的 Web 下载 zip。 */
async function handleDownload(actor: ActorContext, nameOrKey: string): Promise<WebHandlerResult> {
  const detail = await getSkillServerModule().facade.get(actor, nameOrKey);
  if (!detail) throw new NotFoundError(`Skill '${nameOrKey}' not found`);
  // 内容只存在于归属组织的目录下：跨组织公开的 Skill 也从归属组织的目录取归档。
  const sourceOrganizationId = detail.scope.organizationId;
  if (sourceOrganizationId === undefined) {
    throw new Error(`Skill '${detail.name}' 归属组织缺失：组织资源必须落在某个组织上`);
  }

  try {
    const sourceDir = skillSourceDir(sourceOrganizationId, detail.name);
    const archiveBuffer = await createSkillArchiveBuffer(sourceDir, { rootDirectory: detail.name });
    return { success: true, data: { archiveBuffer, fileName: `${detail.name}.zip` } };
  } catch (error) {
    // 归档缺失是"内容不可下载"，对调用方等价于资源不存在；这里转成 404 并保留日志上下文。
    console.error(
      `[SkillConfig] skill_download_archive_build_failed org=${sourceOrganizationId} skill=${detail.name}`,
      error,
    );
    throw new NotFoundError(`Skill archive for '${detail.name}' not found`);
  }
}

/** 控制台上传入口的冲突策略只接受 ignore / overwrite（对外 `/api/skills` 用 `overwrite` 布尔）。 */
function resolveConflictStrategy(formData: UploadFormData): ImportConflictStrategy | undefined {
  const value = formData.get("conflictStrategy");
  if (value === null || value === "") return;
  if (value !== "ignore" && value !== "overwrite") throw new ValidationError("冲突策略无效");
  return value;
}

/** 批量上传技能目录（multipart/form-data）。 */
async function handleUpload(actor: ActorContext, request: Request): Promise<WebHandlerResult> {
  const { files, formData } = await readSkillUploadForm(request);
  const result = await getSkillServerModule().facade.importDirectories(actor, files, resolveConflictStrategy(formData));
  if (result.conflicts.length > 0) return buildSkillConflictBody(result.conflicts);
  return { success: true, data: { imported: result.imported, skipped: result.skipped, conflicts: [] } };
}

// ── 路由注册 ──

const app = new Elysia({ name: "web-config-skills" }).use(authGuardPlugin);

/** 宽松对象响应 schema：各 handler 的 data 结构不同，统一用宽松映射保持 OpenAPI 可读。 */
const looseOkSchema = WebOkSchema(z.union([z.looseObject({}), z.null()]));

const nameOrKeyParam = {
  name: "name",
  in: "path" as const,
  required: true,
  description: "Skill 名称或跨组织资源键（org_id/skill-uuid）。",
  schema: { type: "string" as const },
};

/** 列出所有 Skill（GET /config/skills） */
app.get(
  "/config/skills",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  ({ store, status }: any) => runWebHandler(status, store, (actor) => handleList(actor)),
  {
    sessionAuth: true,
    response: { 200: looseOkSchema, 400: WebErrSchema, 401: WebErrSchema, 403: WebErrSchema },
    detail: {
      tags: ["SkillConfig"],
      summary: "列出所有 Skill",
      description: "返回当前主体可见的所有 Skill 列表（含归属 `scope` 与有效动作 `access.actions`）。",
    },
  },
);

/** 获取单个 Skill 详情（GET /config/skills/:name） */
app.get(
  "/config/skills/:name",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  ({ store, params, status }: any) => runWebHandler(status, store, (actor) => handleGet(actor, params.name as string)),
  {
    sessionAuth: true,
    response: { 200: looseOkSchema, 400: WebErrSchema, 401: WebErrSchema, 403: WebErrSchema, 404: WebErrSchema },
    detail: {
      tags: ["SkillConfig"],
      summary: "获取单个 Skill 详情",
      description: "按名称或跨组织资源键返回 Skill 详情，包含 SKILL.md 正文与元数据。",
      parameters: [nameOrKeyParam],
    },
  },
);

/** 直接下载单个 Skill（GET /config/skills/:name/download） */
app.get(
  "/config/skills/:name/download",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, params, status, set }: any) => {
    const result = await runWebHandler(status, store, (actor) => handleDownload(actor, params.name as string));
    // 归档是二进制流：失败响应由 runWebHandler 映射好后原样返回，只有成功态才需要写响应头。
    if (!isWebSuccess(result)) return result;
    const data = result.data as { archiveBuffer: Buffer; fileName: string };
    set.headers["Content-Type"] = "application/zip";
    set.headers["Content-Disposition"] = `attachment; filename="${data.fileName}"`;
    return new Response(data.archiveBuffer);
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["SkillConfig"],
      summary: "下载 Skill 压缩包",
      description: "基于当前 Web 登录态与资源可见性校验后，直接返回 Skill zip 文件流。",
      parameters: [nameOrKeyParam],
    },
  },
);

/** 创建新 Skill（POST /config/skills） */
app.post(
  "/config/skills",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  ({ store, body, status }: any) => runWebHandler(status, store, (actor) => handleCreate(actor, body)),
  {
    sessionAuth: true,
    response: { 200: looseOkSchema, 400: WebErrSchema, 401: WebErrSchema, 403: WebErrSchema, 409: WebErrSchema },
    detail: {
      tags: ["SkillConfig"],
      summary: "创建新 Skill",
      description: "创建新的 Skill；当前组织下已有同名 Skill 时返回 409 CONFLICT。",
    },
  },
);

/** 更新已有 Skill（PUT /config/skills/:name） */
app.put(
  "/config/skills/:name",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  ({ store, params, body, status }: any) =>
    runWebHandler(status, store, (actor) => handleUpdate(actor, params.name as string, body)),
  {
    sessionAuth: true,
    response: {
      200: looseOkSchema,
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["SkillConfig"],
      summary: "更新已有 Skill",
      description: "更新指定 Skill 的内容、描述与元数据；公开受众请使用独立 access 接口。",
      parameters: [nameOrKeyParam],
    },
  },
);

/** 更新 Skill 公开受众（PUT /config/skills/:name/access） */
app.put(
  "/config/skills/:name/access",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  ({ store, params, body, status }: any) =>
    runWebHandler(status, store, (actor) => handleUpdateAccess(actor, params.name as string, body)),
  {
    sessionAuth: true,
    response: {
      200: looseOkSchema,
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["SkillConfig"],
      summary: "更新 Skill 公开受众",
      description: "仅更新资源公开受众，不读取、解析或改写 SKILL.md。",
      parameters: [nameOrKeyParam],
    },
  },
);

/** 删除 Skill（DELETE /config/skills/:name） */
app.delete(
  "/config/skills/:name",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  ({ store, params, status }: any) =>
    runWebHandler(status, store, (actor) => handleDelete(actor, params.name as string)),
  {
    sessionAuth: true,
    response: { 200: looseOkSchema, 400: WebErrSchema, 401: WebErrSchema, 403: WebErrSchema, 404: WebErrSchema },
    detail: {
      tags: ["SkillConfig"],
      summary: "删除 Skill",
      description: "删除指定的 Skill 配置及其文件系统中的内容。",
      parameters: [nameOrKeyParam],
    },
  },
);

/** 批量上传技能目录（POST /config/skills/upload） */
app.post(
  "/config/skills/upload",
  // 冲突由用户决策而不是请求非法：映射为 409 并带上冲突清单，前端据此弹出覆盖/忽略选择。
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, request, status }: any) =>
    runWebHandler(status, store, (actor) => handleUpload(actor, request), { SKILL_CONFLICT: 409 }),
  {
    sessionAuth: true,
    response: {
      200: looseOkSchema,
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      409: SkillUploadConflictSchema,
    },
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
