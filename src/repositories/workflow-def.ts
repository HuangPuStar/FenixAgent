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

/** 发布版本：复制草稿内容到 v{n}.yaml，更新 latestVersion */
export async function publishVersion(workflowId: string, ctx: AuthCtx): Promise<WorkflowVersionRow> {
  const [wf] = await db
    .select()
    .from(workflow)
    .where(and(eq(workflow.id, workflowId), eq(workflow.organizationId, ctx.organizationId)))
    .limit(1);
  if (!wf?.storagePath) throw new Error("Workflow not found");

  const draftYaml = await readYamlFile(wf.storagePath, "draft.yaml");
  if (!draftYaml) throw new Error("No draft to publish");

  const nextVersion = (wf.latestVersion ?? 0) + 1;
  const fileName = `v${nextVersion}.yaml`;

  await writeYamlFile(wf.storagePath, fileName, draftYaml);

  const [vRow] = await db
    .insert(workflowVersion)
    .values({
      workflowId,
      version: nextVersion,
      filePath: fileName,
      status: "published",
      createdBy: ctx.userId,
    })
    .returning();

  await db.update(workflow).set({ latestVersion: nextVersion }).where(eq(workflow.id, workflowId));

  return vRow;
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
 * 传入 storagePath 可跳过 DB 查询（用于调用方已有 workflow 对象时避免冗余查询）。 */
export async function getVersionYaml(
  workflowId: string,
  version: number,
  /** 已知 storagePath 时传入，避免再次查 DB */
  storagePath?: string | null,
): Promise<string | null> {
  // 优先使用传入的 storagePath，否则查 DB
  const dir =
    storagePath ??
    (await db
      .select()
      .from(workflow)
      .where(eq(workflow.id, workflowId))
      .limit(1)
      .then(([r]) => r?.storagePath));
  if (!dir) {
    console.warn(`[workflow-def] getVersionYaml: storagePath is empty for workflow=${workflowId} version=${version}`);
    return null;
  }

  const fileName = version === 0 ? "draft.yaml" : `v${version}.yaml`;
  return readYamlFile(dir, fileName);
}

/** 设置 latest 指针到指定版本（回滚） */
export async function setLatestVersion(workflowId: string, organizationId: string, version: number): Promise<void> {
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

/** 删除工作流（只删数据库，不动文件系统） */
export async function deleteWorkflowDef(workflowId: string, organizationId: string): Promise<boolean> {
  const result = await db
    .delete(workflow)
    .where(and(eq(workflow.id, workflowId), eq(workflow.organizationId, organizationId)))
    .returning();
  return result.length > 0;
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

/** 从文件系统恢复工作流 */
export async function recoverWorkflows(ctx: AuthCtx, workflowIds: string[]): Promise<WorkflowDefRow[]> {
  const results: WorkflowDefRow[] = [];
  for (const wid of workflowIds) {
    const dir = buildStoragePath(WORKFLOW_BASE_DIR, ctx.organizationId, wid);
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
    } catch {
      // 目录不存在或为空
    }

    results.push({ ...row, storagePath: dir });
  }
  return results;
}

/** 恢复已发布版本内容到草稿 */
export async function restoreVersionToDraft(workflowId: string, ctx: AuthCtx, version: number): Promise<void> {
  const yaml = await getVersionYaml(workflowId, version);
  if (!yaml) throw new Error(`Version ${version} not found`);
  await saveDraft(workflowId, ctx, yaml);
}
