/**
 * Workflow Definition Repository。
 *
 * 管理工作流定义（workflow 表）和版本（workflowVersion 表）的 CRUD。
 * YAML 内容通过 workflow-fs 读写文件系统，数据库只存路径引用。
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { workflow, workflowVersion } from "../db/schema";
import {
  buildStoragePath,
  ensureWorkflowDir,
  listRecoverable as fsListRecoverable,
  readYamlFile,
  resolveStorageDir,
  WORKFLOW_BASE_DIR,
  writeYamlFile,
} from "../services/workflow/workflow-fs";

// ── 类型 ──

export interface WorkflowDefRow {
  id: string;
  userId: string;
  organizationId: string;
  name: string;
  description: string | null;
  latestVersion: number | null;
  storagePath: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowVersionRow {
  id: string;
  workflowId: string;
  version: number;
  filePath: string;
  status: string;
  createdBy: string;
  createdAt: Date;
}

export interface AuthCtx {
  organizationId: string;
  userId: string;
}

// ── CRUD ──

/** 创建工作流定义 + 空草稿目录 */
export async function createWorkflowDef(
  ctx: AuthCtx,
  data: { name: string; description?: string },
  baseDir: string = WORKFLOW_BASE_DIR,
): Promise<WorkflowDefRow> {
  const [row] = await db
    .insert(workflow)
    .values({
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      name: data.name,
      description: data.description ?? null,
      storagePath: "",
    })
    .returning();

  // 多租户关键：路径必须包含 organizationId 隔离层
  const storagePath = buildStoragePath(baseDir, ctx.organizationId, row.id);
  await db.update(workflow).set({ storagePath }).where(eq(workflow.id, row.id));

  await ensureWorkflowDir(storagePath);

  return { ...row, storagePath };
}

/** 保存草稿（upsert version=0） */
export async function saveDraft(workflowId: string, ctx: AuthCtx, yaml: string): Promise<void> {
  const [wf] = await db
    .select()
    .from(workflow)
    .where(and(eq(workflow.id, workflowId), eq(workflow.organizationId, ctx.organizationId)))
    .limit(1);
  if (!wf?.storagePath) throw new Error("Workflow not found");

  const fileName = "draft.yaml";
  await writeYamlFile(wf.storagePath, fileName, yaml);

  const existing = await db
    .select()
    .from(workflowVersion)
    .where(and(eq(workflowVersion.workflowId, workflowId), eq(workflowVersion.version, 0)))
    .limit(1);

  if (existing.length > 0) {
    await db.update(workflowVersion).set({ filePath: fileName }).where(eq(workflowVersion.id, existing[0].id));
  } else {
    await db.insert(workflowVersion).values({
      workflowId,
      version: 0,
      filePath: fileName,
      status: "draft",
      createdBy: ctx.userId,
    });
  }

  await db.update(workflow).set({ updatedAt: new Date() }).where(eq(workflow.id, workflowId));
}

/** 发布版本：复制草稿内容到 v{n}.yaml，更新 latestVersion。
 *  使用事务 + FOR UPDATE 行锁保证并发安全 — 两个用户同时发布不会冲突或拿到相同的 version 号。 */
export async function publishVersion(workflowId: string, ctx: AuthCtx): Promise<WorkflowVersionRow> {
  return db.transaction(async (tx) => {
    // SELECT ... FOR UPDATE 锁定 workflow 行，防止并发 publish 产生重复 version
    const [wf] = await tx
      .select()
      .from(workflow)
      .where(and(eq(workflow.id, workflowId), eq(workflow.organizationId, ctx.organizationId)))
      .for("update")
      .limit(1);
    if (!wf?.storagePath) throw new Error("Workflow not found");

    const draftYaml = await readYamlFile(wf.storagePath, "draft.yaml");
    if (!draftYaml) throw new Error("No draft to publish");

    const nextVersion = (wf.latestVersion ?? 0) + 1;
    const fileName = `v${nextVersion}.yaml`;

    await writeYamlFile(wf.storagePath, fileName, draftYaml);

    const [vRow] = await tx
      .insert(workflowVersion)
      .values({
        workflowId,
        version: nextVersion,
        filePath: fileName,
        status: "published",
        createdBy: ctx.userId,
      })
      .returning();

    await tx.update(workflow).set({ latestVersion: nextVersion }).where(eq(workflow.id, workflowId));

    return vRow;
  });
}

/** 列出工作流（按 updatedAt 降序） */
export async function listWorkflowDefs(organizationId: string): Promise<WorkflowDefRow[]> {
  return db
    .select()
    .from(workflow)
    .where(eq(workflow.organizationId, organizationId))
    .orderBy(desc(workflow.updatedAt));
}

/** 获取单个工作流 */
export async function getWorkflowDef(workflowId: string, organizationId: string): Promise<WorkflowDefRow | null> {
  const [row] = await db
    .select()
    .from(workflow)
    .where(and(eq(workflow.id, workflowId), eq(workflow.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

/** 获取版本历史列表（不含草稿） */
export async function getVersions(workflowId: string, organizationId: string): Promise<WorkflowVersionRow[]> {
  const wf = await getWorkflowDef(workflowId, organizationId);
  if (!wf) return [];

  return db
    .select()
    .from(workflowVersion)
    .where(and(eq(workflowVersion.workflowId, workflowId), sql`${workflowVersion.version} > 0`))
    .orderBy(desc(workflowVersion.version));
}

/** 获取特定版本的 YAML 内容。
 *
 * 多租户关键：必须传 organizationId 才允许 DB fallback，否则跨组织泄露。
 * 已知 storagePath 时可跳过 DB 查询（调用方已有 workflow 对象）。
 */
export async function getVersionYaml(
  workflowId: string,
  version: number,
  opts: { organizationId: string; storagePath?: string | null },
): Promise<string | null>;

/** @deprecated 双参数版本 — 仅用于向后兼容，会记录 warning。新代码必须传 opts.organizationId。 */
export async function getVersionYaml(
  workflowId: string,
  version: number,
  storagePath?: string | null,
): Promise<string | null>;

export async function getVersionYaml(
  workflowId: string,
  version: number,
  optsOrStoragePath?: { organizationId: string; storagePath?: string | null } | string | null | undefined,
): Promise<string | null> {
  const isOptsObject =
    optsOrStoragePath !== null && typeof optsOrStoragePath === "object" && !Array.isArray(optsOrStoragePath);
  const opts = isOptsObject
    ? (optsOrStoragePath as { organizationId: string; storagePath?: string | null })
    : undefined;
  const storagePathLegacy = !isOptsObject ? (optsOrStoragePath as string | null | undefined) : undefined;

  if (!opts?.organizationId) {
    console.warn(
      `[workflow-def] getVersionYaml deprecation: workflowId=${workflowId} called without organizationId — caller stack should be updated`,
    );
  }

  // 优先使用传入的 storagePath；否则带 organizationId 查 DB
  let dir: string | null | undefined;
  if (isOptsObject) {
    dir = opts?.storagePath;
  } else {
    dir = storagePathLegacy;
  }
  if (!dir) {
    const [wf] = opts?.organizationId
      ? await db
          .select({ storagePath: workflow.storagePath })
          .from(workflow)
          .where(and(eq(workflow.id, workflowId), eq(workflow.organizationId, opts.organizationId)))
          .limit(1)
      : await db
          .select({ storagePath: workflow.storagePath })
          .from(workflow)
          .where(eq(workflow.id, workflowId))
          .limit(1);
    dir = wf?.storagePath;
  }

  if (!dir) {
    console.warn(`[workflow-def] getVersionYaml: storagePath is empty for workflow=${workflowId} version=${version}`);
    return null;
  }

  const fileName = version === 0 ? "draft.yaml" : `v${version}.yaml`;
  return readYamlFile(dir, fileName);
}

/** 设置 latest 指针到指定版本（回滚）。
 *  校验 version 必须属于该 workflowId，防止跨工作流误改。 */
export async function setLatestVersion(workflowId: string, organizationId: string, version: number): Promise<void> {
  // 校验 version 归属 workflowId（workflowVersion 表本身没有 organizationId，
  // 但 workflowId 必须属于当前 organizationId 才允许操作）
  const [wf] = await db
    .select({ id: workflow.id })
    .from(workflow)
    .where(and(eq(workflow.id, workflowId), eq(workflow.organizationId, organizationId)))
    .limit(1);
  if (!wf) throw new Error(`Workflow ${workflowId} not found in organization`);

  const [vRow] = await db
    .select()
    .from(workflowVersion)
    .where(and(eq(workflowVersion.workflowId, workflowId), eq(workflowVersion.version, version)))
    .limit(1);
  if (!vRow) throw new Error(`Version ${version} not found`);

  await db
    .update(workflow)
    .set({ latestVersion: version })
    .where(and(eq(workflow.id, workflowId), eq(workflow.organizationId, organizationId)));
}

/** 删除工作流（数据库 + 文件系统 YAML 目录，原子清理）
 *  注意：YAML 目录删除失败只记日志不抛错，避免 DB 已删但接口报错造成不一致。
 *  保留 baseDir 参数仅为 API 兼容（调用方可能传入）；实际删除走 DB storagePath 字段。 */
export async function deleteWorkflowDef(
  workflowId: string,
  organizationId: string,
  _baseDir: string = WORKFLOW_BASE_DIR,
): Promise<boolean> {
  const result = await db
    .delete(workflow)
    .where(and(eq(workflow.id, workflowId), eq(workflow.organizationId, organizationId)))
    .returning({ storagePath: workflow.storagePath });
  if (result.length === 0) return false;

  const storagePath = result[0].storagePath;
  if (storagePath) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(storagePath, { recursive: true, force: true });
    } catch (err) {
      console.error(`[workflow-def] deleteWorkflowDef: failed to remove ${storagePath}:`, err);
    }
  }
  return true;
}

/** 更新工作流元数据（name, description） */
export async function updateWorkflowMeta(
  workflowId: string,
  organizationId: string,
  data: { name?: string; description?: string },
): Promise<WorkflowDefRow | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;

  const [row] = await db
    .update(workflow)
    .set(updates)
    .where(and(eq(workflow.id, workflowId), eq(workflow.organizationId, organizationId)))
    .returning();
  return row ?? null;
}

/** 扫描文件系统中可恢复的孤立工作流 */
export async function listRecoverableWorkflows(organizationId: string): Promise<string[]> {
  const existing = await db
    .select({ id: workflow.id })
    .from(workflow)
    .where(eq(workflow.organizationId, organizationId));
  const existingIds = new Set(existing.map((r) => r.id));

  return fsListRecoverable(WORKFLOW_BASE_DIR, organizationId, existingIds);
}

/** 从文件系统恢复工作流。
 *  多租户关键：只读取 `<baseDir>/<organizationId>/<workflowId>/` 路径下的 YAML，
 *  绝不跨组织扫描。 */
export async function recoverWorkflows(ctx: AuthCtx, workflowIds: string[]): Promise<WorkflowDefRow[]> {
  const results: WorkflowDefRow[] = [];
  for (const wid of workflowIds) {
    // 优先用带 organizationId 隔离的新路径；旧数据兼容回退到无 org 的路径
    const dir =
      (await resolveStorageDir(WORKFLOW_BASE_DIR, ctx.organizationId, wid)) ??
      buildStoragePath(WORKFLOW_BASE_DIR, ctx.organizationId, wid);
    const draftYaml = await readYamlFile(dir, "draft.yaml");
    let name = wid;
    if (draftYaml) {
      const match = draftYaml.match(/^name:\s*(.+)$/m);
      if (match) name = match[1].trim();
    }

    const [row] = await db
      .insert(workflow)
      .values({
        id: wid,
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        name,
        storagePath: dir,
      })
      .returning();

    if (draftYaml) {
      await db
        .insert(workflowVersion)
        .values({
          workflowId: wid,
          version: 0,
          filePath: "draft.yaml",
          status: "draft",
          createdBy: ctx.userId,
        })
        .onConflictDoNothing();
    }

    const { readdir: readdirFn } = await import("node:fs/promises");
    try {
      const files = await readdirFn(dir);
      const versionFiles = files.filter((f) => /^v(\d+)\.yaml$/.test(f));
      for (const f of versionFiles) {
        const ver = parseInt(f.match(/^v(\d+)\.yaml$/)![1], 10);
        await db
          .insert(workflowVersion)
          .values({
            workflowId: wid,
            version: ver,
            filePath: f,
            status: "published",
            createdBy: ctx.userId,
          })
          .onConflictDoNothing();
      }
      if (versionFiles.length > 0) {
        const maxVer = Math.max(...versionFiles.map((f) => parseInt(f.match(/^v(\d+)/)![1], 10)));
        await db.update(workflow).set({ latestVersion: maxVer }).where(eq(workflow.id, wid));
      }
    } catch (err) {
      // 目录不存在或为空 — 仅记录，不阻塞恢复流程
      console.warn(`[workflow-def] recoverWorkflows: cannot read dir ${dir}:`, err);
    }

    results.push({ ...row, storagePath: dir });
  }
  return results;
}

/** 恢复已发布版本内容到草稿 */
export async function restoreVersionToDraft(workflowId: string, ctx: AuthCtx, version: number): Promise<void> {
  const yaml = await getVersionYaml(workflowId, version, {
    organizationId: ctx.organizationId,
  });
  if (!yaml) throw new Error(`Version ${version} not found`);
  await saveDraft(workflowId, ctx, yaml);
}
