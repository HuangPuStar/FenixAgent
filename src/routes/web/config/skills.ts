import Elysia from "elysia";
import { authGuardPlugin } from "../../../plugins/auth";
import { environmentRepo } from "../../../repositories";
import { ConfigBodySchema } from "../../../schemas/config.schema";
import { configSuccess, configError, configValidationError, configNotFound } from "../../../services/config-utils";
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

const app = new Elysia({ name: "web-config-skills", prefix: "/web" })
  .use(authGuardPlugin)
  .model({
    "config-body": ConfigBodySchema,
  });

async function handleList(user: { id: string }) {
  const skills = await listSkills(user.id);
  return configSuccess({ skills });
}

async function handleWorkspaceList(user: { id: string }) {
  const sources = await listSkillSources(user.id);
  return configSuccess({ sources });
}

async function handleGet(user: { id: string }, body: { name?: string; source?: string; workspaceId?: string }, errorFn: (status: number, body: unknown) => any) {
  if (!body.name) {
    return errorFn(400, configValidationError("Missing 'name' field"));
  }
  if (body.source === "workspace" && body.workspaceId) {
    const env = await environmentRepo.getById(body.workspaceId);
    if (!env) return errorFn(404, configNotFound("Workspace not found"));
    const skill = await getWorkspaceSkill(env.workspacePath, body.name);
    if (!skill) return errorFn(404, configNotFound(`Skill '${body.name}' not found`));
    return configSuccess(skill);
  }
  const skill = await getSkill(user.id, body.name);
  if (!skill) {
    return errorFn(404, configNotFound(`Skill '${body.name}' not found`));
  }
  return configSuccess(skill);
}

async function handleSet(user: { id: string }, body: { name?: string; data?: { description: string; content: string; metadata?: Record<string, string> }; source?: string; workspaceId?: string }, errorFn: (status: number, body: unknown) => any) {
  if (!body.name) {
    return errorFn(400, configValidationError("Missing 'name' field"));
  }
  if (!body.data || !body.data.description || !body.data.content) {
    return errorFn(400, configValidationError("Missing required fields: data.description, data.content"));
  }
  if (body.source === "workspace" && body.workspaceId) {
    const env = await environmentRepo.getById(body.workspaceId);
    if (!env) return errorFn(404, configNotFound("Workspace not found"));
    const result = await setWorkspaceSkill(env.workspacePath, body.name, body.data);
    return configSuccess({ name: result.name, enabled: result.enabled });
  }
  const result = await setSkill(user.id, body.name, body.data);
  return configSuccess({ name: result.name, enabled: result.enabled });
}

async function handleDelete(user: { id: string }, body: { name?: string; source?: string; workspaceId?: string }, errorFn: (status: number, body: unknown) => any) {
  if (!body.name) {
    return errorFn(400, configValidationError("Missing 'name' field"));
  }
  if (body.source === "workspace" && body.workspaceId) {
    const env = await environmentRepo.getById(body.workspaceId);
    if (!env) return errorFn(404, configNotFound("Workspace not found"));
    const deleted = await deleteWorkspaceSkill(env.workspacePath, body.name);
    if (!deleted) return errorFn(404, configNotFound(`Skill '${body.name}' not found`));
    return configSuccess(null);
  }
  const deleted = await deleteSkill(user.id, body.name);
  if (!deleted) {
    return errorFn(404, configNotFound(`Skill '${body.name}' not found`));
  }
  return configSuccess(null);
}

async function handleEnable(user: { id: string }, body: { name?: string }, errorFn: (status: number, body: unknown) => any) {
  if (!body.name) {
    return errorFn(400, configValidationError("Missing 'name' field"));
  }
  const enabled = await enableSkill(user.id, body.name);
  if (!enabled) {
    return errorFn(404, configNotFound(`Skill '${body.name}' not found`));
  }
  return configSuccess({ name: body.name, enabled: true });
}

async function handleDisable(user: { id: string }, body: { name?: string }, errorFn: (status: number, body: unknown) => any) {
  if (!body.name) {
    return errorFn(400, configValidationError("Missing 'name' field"));
  }
  const disabled = await disableSkill(user.id, body.name);
  if (!disabled) {
    return errorFn(404, configNotFound(`Skill '${body.name}' not found`));
  }
  return configSuccess({ name: body.name, enabled: false });
}

interface UploadManifestEntry {
  skillName: string;
  relativePath: string;
}

async function handleUpload(user: { id: string }, request: Request, errorFn: (status: number, body: unknown) => any) {
  let formData: globalThis.FormData | null;
  try {
    formData = await request.formData() as globalThis.FormData;
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
      const env = await environmentRepo.getById(workspaceIdValue);
      if (!env) return errorFn(404, configNotFound("Workspace not found"));
      const result = await importWorkspaceSkillDirectories(env.workspacePath, uploadFiles, conflictStrategy);
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
    }

    const result = await importSkillDirectories(user.id, uploadFiles, conflictStrategy);
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
    const code = error_ instanceof Error && "code" in error_ && typeof error_.code === "string" ? error_.code : "UNKNOWN_ERROR";
    const message = error_ instanceof Error ? error_.message : "技能导入失败";
    const status = code === "VALIDATION_ERROR" ? 400 : 500;
    return errorFn(status, configError(code, message));
  }
}

type SkillBody = { action: string; name?: string; data?: { description: string; content: string; metadata?: Record<string, string> }; source?: string; workspaceId?: string };

app.post("/config/skills", async ({ store, body, error }) => {
  const b = (body as any) ?? {};
  const payload: SkillBody = { action: b.action ?? "", name: b.name, data: b.data, source: b.source, workspaceId: b.workspaceId };
  const { action } = payload;
  const user = store.user!;

  const errFn = (status: number, data: unknown) => error(status, data);

  switch (action) {
    case "workspace_list": return await handleWorkspaceList(user);
    case "list": return await handleList(user);
    case "get": return await handleGet(user, payload, errFn);
    case "set": return await handleSet(user, payload, errFn);
    case "delete": return await handleDelete(user, payload, errFn);
    case "enable": return await handleEnable(user, payload, errFn);
    case "disable": return await handleDisable(user, payload, errFn);
    default:
      return error(400, configValidationError(`Unknown action: ${action}`));
  }
}, { sessionAuth: true, body: "config-body" });

app.post("/config/skills/upload", async ({ store, request, error }) => {
  const user = store.user!;
  return await handleUpload(user, request, (status, data) => error(status, data));
}, { sessionAuth: true });

export default app;
