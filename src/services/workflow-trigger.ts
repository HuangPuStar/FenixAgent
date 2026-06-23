import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getBaseUrl } from "../config";
import type { WorkflowTriggerRow } from "../repositories/workflow-trigger";
import { workflowTriggerRepo } from "../repositories/workflow-trigger";

// ── 类型 ──

export interface CreateTriggerInput {
  organizationId: string;
  workflowId: string;
  type: string;
  userId: string;
  config?: Record<string, unknown>;
}

export interface TriggerView {
  id: string;
  workflowId: string;
  type: string;
  publicHash: string;
  maskedHash: string;
  webhookUrl: string | null;
  secret: string | null;
  config: Record<string, unknown> | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ── 辅助 ──

/** 生成 32 字节 hex hash */
export function generateHash(): string {
  return randomBytes(32).toString("hex");
}

/** masked 展示：前 6 位 + *** */
export function maskHash(hash: string): string {
  if (hash.length <= 6) return `${hash}***`;
  return `${hash.slice(0, 6)}***`;
}

/** 构造完整 webhook URL */
function buildWebhookUrl(publicHash: string): string {
  return `${getBaseUrl()}/hooks/${publicHash}`;
}

/** 将行转换为视图（masked hash，不含完整 webhookUrl） */
export function rowToMaskedView(row: WorkflowTriggerRow): TriggerView {
  return {
    id: row.id,
    workflowId: row.workflowId,
    type: row.type,
    publicHash: maskHash(row.publicHash),
    maskedHash: maskHash(row.publicHash),
    webhookUrl: null,
    secret: row.secret ?? null,
    config: (row.config as Record<string, unknown>) ?? null,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 将行转换为完整视图（含完整 webhookUrl，仅在 create/regenerate 时使用） */
function rowToFullView(row: WorkflowTriggerRow): TriggerView {
  return {
    ...rowToMaskedView(row),
    publicHash: row.publicHash,
    webhookUrl: buildWebhookUrl(row.publicHash),
  };
}

// ── CRUD ──

export async function createTrigger(input: CreateTriggerInput): Promise<TriggerView> {
  const publicHash = generateHash();
  const row = await workflowTriggerRepo.create({
    organizationId: input.organizationId,
    workflowId: input.workflowId,
    type: input.type,
    publicHash,
    enabled: true,
    config: input.config ?? null,
  });
  return rowToFullView(row);
}

export async function listTriggers(workflowId: string, organizationId: string): Promise<TriggerView[]> {
  // 通过 listByOrg + workflowId 过滤实现双重隔离
  const rows = await workflowTriggerRepo.listByOrg(organizationId);
  return rows.filter((r) => r.workflowId === workflowId).map(rowToMaskedView);
}

export async function deleteTrigger(triggerId: string, organizationId: string): Promise<boolean> {
  const row = await workflowTriggerRepo.getById(triggerId);
  if (!row || row.organizationId !== organizationId) return false;
  return workflowTriggerRepo.delete(triggerId);
}

export async function regenerateHash(triggerId: string, organizationId: string): Promise<TriggerView | null> {
  const row = await workflowTriggerRepo.getById(triggerId);
  if (!row || row.organizationId !== organizationId) return null;
  const newHash = generateHash();
  await workflowTriggerRepo.update(triggerId, { publicHash: newHash, updatedAt: new Date() });
  const updated = await workflowTriggerRepo.getById(triggerId);
  return updated ? rowToFullView(updated) : null;
}

export async function enableTrigger(triggerId: string, organizationId: string): Promise<boolean> {
  const row = await workflowTriggerRepo.getById(triggerId);
  if (!row || row.organizationId !== organizationId) return false;
  await workflowTriggerRepo.update(triggerId, { enabled: true, updatedAt: new Date() });
  return true;
}

export async function disableTrigger(triggerId: string, organizationId: string): Promise<boolean> {
  const row = await workflowTriggerRepo.getById(triggerId);
  if (!row || row.organizationId !== organizationId) return false;
  await workflowTriggerRepo.update(triggerId, { enabled: false, updatedAt: new Date() });
  return true;
}

// ── Webhook 处理 ──

export interface WebhookPayload {
  [key: string]: unknown;
  headers: Record<string, string>;
  body: unknown;
  query: Record<string, string>;
  triggerType: string;
}

/**
 * 处理 webhook 请求：查 hash → 验证 trigger → 异步触发 workflow。
 * 返回 true 表示已接受，false 表示 trigger 未找到/disabled。
 */
export async function handleWebhookRequest(
  publicHash: string,
  headers: Record<string, string>,
  body: unknown,
  query: Record<string, string>,
): Promise<{ accepted: boolean; error?: string }> {
  const row = await workflowTriggerRepo.getByHash(publicHash);
  if (!row?.enabled) return { accepted: false, error: "trigger not found" };

  const inputs: WebhookPayload = {
    headers,
    body,
    query,
    triggerType: row.type,
  };

  // fire-and-forget：不 await engine.run 完成
  triggerWorkflow(row.organizationId, row.workflowId, inputs).catch((err) => {
    console.error(`[workflow-trigger] Failed to trigger workflow ${row.workflowId}:`, err);
  });

  return { accepted: true };
}

/** 触发 workflow 执行 */
async function triggerWorkflow(organizationId: string, workflowId: string, inputs: WebhookPayload): Promise<void> {
  const { getTeamEngine } = await import("./workflow");
  const { getVersionYaml } = await import("../repositories/workflow-def");

  const engine = getTeamEngine(organizationId);

  // 获取最新版本的 YAML — 多租户关键：必须带 organizationId 过滤
  const { db } = await import("../db");
  const { workflow } = await import("../db/schema");
  const [wf] = await db
    .select()
    .from(workflow)
    .where(and(eq(workflow.id, workflowId), eq(workflow.organizationId, organizationId)))
    .limit(1);
  if (!wf) throw new Error(`Workflow ${workflowId} not found`);

  const version = wf.latestVersion ?? 0;
  const yaml = await getVersionYaml(workflowId, version, {
    organizationId,
    storagePath: wf.storagePath,
  });
  if (!yaml) throw new Error(`No YAML found for workflow ${workflowId} version ${version}`);

  await engine.run(yaml, inputs);
}
