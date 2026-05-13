import { Hono } from "hono";
import type { Context } from "hono";
import { sessionAuth } from "../../../auth/middleware";
import { storeGetEnvironment } from "../../../store";
import {
  listSkills,
  getSkill,
  setSkill,
  deleteSkill,
  enableSkill,
  disableSkill,
  importSkillDirectories,
  importWorkspaceSkillDirectories,
  listSkillSources,
  getWorkspaceSkill,
  setWorkspaceSkill,
  deleteWorkspaceSkill,
  type ImportConflictStrategy,
} from "../../../services/skill";

const app = new Hono();

function successResponse(data: unknown) {
  return { success: true, data };
}

function errorResponse(code: string, message: string, data?: unknown) {
  return { success: false, error: { code, message }, ...(data !== undefined ? { data } : {}) };
}

async function handleList(c: Context) {
  const skills = await listSkills();
  return c.json(successResponse({ skills }));
}

async function handleWorkspaceList(c: Context) {
  const user = c.get("user")!;
  const sources = await listSkillSources(user.id);
  return c.json(successResponse({ sources }));
}

async function handleGet(c: Context, body: { name?: string; source?: string; workspaceId?: string }) {
  if (!body.name) {
    return c.json(errorResponse("VALIDATION_ERROR", "Missing 'name' field"), 400);
  }
  if (body.source === "workspace" && body.workspaceId) {
    const env = storeGetEnvironment(body.workspaceId);
    if (!env) return c.json(errorResponse("NOT_FOUND", "Workspace not found"), 404);
    const skill = await getWorkspaceSkill(env.workspacePath, body.name);
    if (!skill) return c.json(errorResponse("NOT_FOUND", `Skill '${body.name}' not found`), 404);
    return c.json(successResponse(skill));
  }
  const skill = await getSkill(body.name);
  if (!skill) {
    return c.json(errorResponse("NOT_FOUND", `Skill '${body.name}' not found`), 404);
  }
  return c.json(successResponse(skill));
}

async function handleSet(c: Context, body: { name?: string; data?: { description: string; content: string; metadata?: Record<string, string> }; source?: string; workspaceId?: string }) {
  if (!body.name) {
    return c.json(errorResponse("VALIDATION_ERROR", "Missing 'name' field"), 400);
  }
  if (!body.data || !body.data.description || !body.data.content) {
    return c.json(errorResponse("VALIDATION_ERROR", "Missing required fields: data.description, data.content"), 400);
  }
  if (body.source === "workspace" && body.workspaceId) {
    const env = storeGetEnvironment(body.workspaceId);
    if (!env) return c.json(errorResponse("NOT_FOUND", "Workspace not found"), 404);
    const result = await setWorkspaceSkill(env.workspacePath, body.name, body.data);
    return c.json(successResponse({ name: result.name, enabled: result.enabled }));
  }
  const result = await setSkill(body.name, body.data);
  return c.json(successResponse({ name: result.name, enabled: result.enabled }));
}

async function handleDelete(c: Context, body: { name?: string; source?: string; workspaceId?: string }) {
  if (!body.name) {
    return c.json(errorResponse("VALIDATION_ERROR", "Missing 'name' field"), 400);
  }
  if (body.source === "workspace" && body.workspaceId) {
    const env = storeGetEnvironment(body.workspaceId);
    if (!env) return c.json(errorResponse("NOT_FOUND", "Workspace not found"), 404);
    const deleted = await deleteWorkspaceSkill(env.workspacePath, body.name);
    if (!deleted) return c.json(errorResponse("NOT_FOUND", `Skill '${body.name}' not found`), 404);
    return c.json(successResponse(null));
  }
  const deleted = await deleteSkill(body.name);
  if (!deleted) {
    return c.json(errorResponse("NOT_FOUND", `Skill '${body.name}' not found`), 404);
  }
  return c.json(successResponse(null));
}

async function handleEnable(c: Context, body: { name?: string }) {
  if (!body.name) {
    return c.json(errorResponse("VALIDATION_ERROR", "Missing 'name' field"), 400);
  }
  const enabled = await enableSkill(body.name);
  if (!enabled) {
    return c.json(errorResponse("NOT_FOUND", `Skill '${body.name}' not found in disabled directory`), 404);
  }
  return c.json(successResponse({ name: body.name, enabled: true }));
}

async function handleDisable(c: Context, body: { name?: string }) {
  if (!body.name) {
    return c.json(errorResponse("VALIDATION_ERROR", "Missing 'name' field"), 400);
  }
  const disabled = await disableSkill(body.name);
  if (!disabled) {
    return c.json(errorResponse("NOT_FOUND", `Skill '${body.name}' not found in enabled directory`), 404);
  }
  return c.json(successResponse({ name: body.name, enabled: false }));
}

interface UploadManifestEntry {
  skillName: string;
  relativePath: string;
}

async function handleUpload(c: Context) {
  const formData = await c.req.formData().catch(() => null);
  if (!formData) {
    return c.json(errorResponse("VALIDATION_ERROR", "上传表单解析失败"), 400);
  }

  const manifestRaw = formData.get("manifest");
  if (typeof manifestRaw !== "string") {
    return c.json(errorResponse("VALIDATION_ERROR", "缺少 manifest"), 400);
  }

  let manifest: UploadManifestEntry[];
  try {
    const parsed = JSON.parse(manifestRaw);
    if (!Array.isArray(parsed)) {
      throw new Error("manifest must be an array");
    }
    manifest = parsed;
  } catch {
    return c.json(errorResponse("VALIDATION_ERROR", "manifest 格式无效"), 400);
  }

  const conflictStrategyValue = formData.get("conflictStrategy");
  let conflictStrategy: ImportConflictStrategy | undefined;
  if (typeof conflictStrategyValue === "string" && conflictStrategyValue) {
    if (conflictStrategyValue !== "ignore" && conflictStrategyValue !== "overwrite") {
      return c.json(errorResponse("VALIDATION_ERROR", "冲突策略无效"), 400);
    }
    conflictStrategy = conflictStrategyValue;
  }

  const files = formData.getAll("files").filter((item: unknown): item is File => item instanceof File);
  if (manifest.length !== files.length) {
    return c.json(errorResponse("VALIDATION_ERROR", "上传文件与 manifest 数量不一致"), 400);
  }

  // Workspace upload support
  const sourceValue = formData.get("source");
  const workspaceIdValue = formData.get("workspaceId");
  const isWorkspaceUpload = sourceValue === "workspace" && typeof workspaceIdValue === "string" && workspaceIdValue;

  try {
    const uploadFiles = await Promise.all(
      manifest.map(async (entry, index) => ({
        skillName: entry.skillName,
        relativePath: entry.relativePath,
        content: await files[index].text(),
      })),
    );

    if (isWorkspaceUpload) {
      const env = storeGetEnvironment(workspaceIdValue);
      if (!env) return c.json(errorResponse("NOT_FOUND", "Workspace not found"), 404);
      const result = await importWorkspaceSkillDirectories(env.workspacePath, uploadFiles, conflictStrategy);
      if (result.conflicts.length > 0) {
        return c.json(
          errorResponse("SKILL_CONFLICT", "检测到同名技能冲突", {
            conflicts: result.conflicts,
            allowedStrategies: ["ignore", "overwrite"],
          }),
          409,
        );
      }
      return c.json(successResponse(result));
    }

    const result = await importSkillDirectories(uploadFiles, conflictStrategy);
    if (result.conflicts.length > 0) {
      return c.json(
        errorResponse("SKILL_CONFLICT", "检测到同名技能冲突", {
          conflicts: result.conflicts,
          allowedStrategies: ["ignore", "overwrite"],
        }),
        409,
      );
    }
    return c.json(successResponse(result));
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN_ERROR";
    const message = error instanceof Error ? error.message : "技能导入失败";
    const status = code === "VALIDATION_ERROR" ? 400 : 500;
    return c.json(errorResponse(code, message), status);
  }
}

type SkillBody = { action: string; name?: string; data?: { description: string; content: string; metadata?: Record<string, string> }; source?: string; workspaceId?: string };

app.post("/config/skills", sessionAuth, async (c) => {
  const body = await c.req.json<SkillBody>().catch((): SkillBody => ({ action: "" }));
  const { action } = body;

  switch (action) {
    case "workspace_list": return handleWorkspaceList(c);
    case "list": return handleList(c);
    case "get": return handleGet(c, body);
    case "set": return handleSet(c, body);
    case "delete": return handleDelete(c, body);
    case "enable": return handleEnable(c, body);
    case "disable": return handleDisable(c, body);
    default:
      return c.json(errorResponse("VALIDATION_ERROR", `Unknown action: ${action}`), 400);
  }
});

app.post("/config/skills/upload", sessionAuth, handleUpload);

export default app;
