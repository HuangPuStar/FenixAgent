/**
 * Workflow Board Repository。
 *
 * 管理看板面板的 CRUD。
 */

import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { workflowBoard } from "../db/schema";

// ── 类型 ──

export interface WorkflowBoardRow {
  id: string;
  organizationId: string;
  name: string;
  userId: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ── CRUD ──

/** 创建 Board */
export async function createBoard(
  organizationId: string,
  userId: string,
  data: { name: string; isDefault?: boolean },
): Promise<WorkflowBoardRow> {
  const [row] = await db
    .insert(workflowBoard)
    .values({
      organizationId,
      userId,
      name: data.name,
      isDefault: data.isDefault ?? false,
    })
    .returning();
  return row as WorkflowBoardRow;
}

/** 获取单个 Board */
export async function getBoard(boardId: string, organizationId: string): Promise<WorkflowBoardRow | null> {
  const [row] = await db
    .select()
    .from(workflowBoard)
    .where(and(eq(workflowBoard.id, boardId), eq(workflowBoard.organizationId, organizationId)))
    .limit(1);
  return (row as WorkflowBoardRow) ?? null;
}

/** 列出组织的所有 Board（default 排最前，其余按创建时间） */
export async function listBoards(organizationId: string): Promise<WorkflowBoardRow[]> {
  const rows = await db
    .select()
    .from(workflowBoard)
    .where(eq(workflowBoard.organizationId, organizationId))
    .orderBy(asc(workflowBoard.isDefault), asc(workflowBoard.createdAt));
  return rows as WorkflowBoardRow[];
}

/** 重命名 Board */
export async function updateBoard(boardId: string, organizationId: string, name: string): Promise<boolean> {
  const result = await db
    .update(workflowBoard)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(workflowBoard.id, boardId), eq(workflowBoard.organizationId, organizationId)))
    .returning();
  return result.length > 0;
}

/** 删除 Board */
export async function deleteBoard(boardId: string, organizationId: string): Promise<boolean> {
  const result = await db
    .delete(workflowBoard)
    .where(and(eq(workflowBoard.id, boardId), eq(workflowBoard.organizationId, organizationId)))
    .returning();
  return result.length > 0;
}

/** 获取组织的 default board（不存在时返回 null） */
export async function getDefaultBoard(organizationId: string): Promise<WorkflowBoardRow | null> {
  const [row] = await db
    .select()
    .from(workflowBoard)
    .where(and(eq(workflowBoard.organizationId, organizationId), eq(workflowBoard.isDefault, true)))
    .limit(1);
  return (row as WorkflowBoardRow) ?? null;
}

/** 确保 default board 存在，不存在则创建 */
export async function ensureDefaultBoard(organizationId: string, userId: string): Promise<WorkflowBoardRow> {
  const existing = await getDefaultBoard(organizationId);
  if (existing) return existing;
  return createBoard(organizationId, userId, { name: "Default Board", isDefault: true });
}
