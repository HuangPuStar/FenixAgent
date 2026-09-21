import { agentSiteApp } from "@fenix/agent-config/db";
import { findMcpServerLabelsByIds } from "@fenix/resource-mcp/server/config";
import { findSkillLabelsByIds } from "@fenix/resource-skill/server/config";
import { knowledgeBase } from "@server/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { getAgentConfigDatabase } from "../db";
import { getMachineLookupPort } from "../ports/machine-lookup";
import { getModelLookupPort } from "../ports/model-lookup";
import type { AgentNode } from "./config/types";

/**
 * Agent 关联资源的**展示投影**：把绑定表里的资源 ID 解析成前端可直接渲染的标签。
 *
 * 只读、无授权判断：绑定集合的可见性由调用方在持有 actor 的层次上先行确定，这里只负责把已经
 * 确定下来的 ID 换成名称——因此任何解析失败都降级为「用 ID 当标签」，不让一个坏标签拖垮整个
 * 列表（与迁移前的行为一致；见 {@link buildAgentRelatedResourceView} 的兜底分支）。
 *
 * 搬迁自 `routes/web/config/agent-route-support.ts`：原实现直接放在路由里，违反「route 不得直接
 * 访问 db」。本次是纯搬迁，没有顺带改动查询形状或兜底策略。
 *
 * 跨包表分两类读法，差别不是风格，而是**本包能否直接导入对方**：
 * - 走宿主注入端口：`machine`（§1.7 B1，经 {@link MachineLookupPort}）与 `model` / `provider`（B3，经
 *   {@link getModelLookupPort}）——这两个包的 `dependsOn` 都已含本包，反向声明会闭合装配环。
 * - 走对方已声明的公开入口：MCP 标签经 `@fenix/resource-mcp/server/config` 的
 *   {@link findMcpServerLabelsByIds}（本包 `dependsOn` 已含 mcp），Skill 标签经
 *   `@fenix/resource-skill/server/config` 的 {@link findSkillLabelsByIds}（同因，B5）——两条边方向都合法。
 * `agent_site_app` 随 B7 与聚合根一起归本包（`@fenix/agent-config/db`，从本包自己的 db 出口取）；只剩
 * `knowledge_base` 仍经 `@server/db/schema`，它的所有权随知识库包迁移属后续批次（B9），届时按同一口径
 * 改为经 owner 的公开入口或端口取数。DB 句柄改经 `getAgentConfigDatabase()` 请求期取得（`@server/db`
 * 的模块级句柄已切断）。
 */

/** 关联资源标签视图；字段与 `/web/config/agents` 响应的 `relatedResources` 一一对应。 */
export interface AgentRelatedResourceView {
  readonly modelLabel: string | null;
  readonly machineLabel: string | null;
  readonly skills: ReadonlyArray<{ id: string; label: string }>;
  readonly mcps: ReadonlyArray<{ id: string; label: string }>;
  readonly knowledgeBases: ReadonlyArray<{ id: string; label: string; slug?: string | null }>;
  readonly siteApps: ReadonlyArray<{ id: string; label: string; remoteAppId: string | null }>;
}

/**
 * 标签解析输入。
 *
 * `organizationId` 是资源自身的归属组织（不是当前 active organization）：跨组织可见的 Agent 也要
 * 用**资源归属组织**去解析知识库与 Site App，否则会拿对方的绑定 ID 在本组织查不到而退化成 ID 标签。
 */
export interface AgentRelatedResourceInput {
  readonly id: string;
  readonly organizationId: string;
  readonly modelId: string | null;
  readonly agentNode: AgentNode;
  readonly skillIds: readonly string[];
  readonly mcpIds: readonly string[];
  readonly siteAppIds: readonly string[];
  /** 知识库绑定 ID；由调用方从绑定表读出后传入，本模块不反向依赖 knowledge 资源包。 */
  readonly knowledgeBaseIds: readonly string[];
}

/**
 * 解析模型标签：`<provider 展示名>/<模型展示名>`；任一段缺失时退回 modelId。
 *
 * 标签怎么拼（含缺失时回退到 `name` / `model_id`）由 model-management 的只读投影决定，见
 * {@link getModelLookupPort}；这里只保留「取不到就退回 id」这一层视图语义。
 */
async function resolveModelLabel(modelId: string | null): Promise<string | null> {
  if (!modelId) return null;
  const labels = await getModelLookupPort().findModelLabelsByIds([modelId]);
  return labels.get(modelId) ?? modelId;
}

/**
 * 解析执行节点标签。标签回退链（人工命名 → 主机名 → Agent 名）由 machine 侧算好（见
 * {@link MachineLookupPort}）；这里只负责「取不到就退回 id」这一层视图语义。
 */
async function resolveMachineLabel(agentNode: AgentNode): Promise<string | null> {
  if (agentNode.kind !== "machine") return null;
  const labels = await getMachineLookupPort().findMachineLabelsByIds([agentNode.machineId]);
  return labels.get(agentNode.machineId) ?? agentNode.machineId;
}

/** 构造全 ID 兜底视图：任何一步解析失败时整体回退到这里。 */
function buildFallbackView(input: AgentRelatedResourceInput): AgentRelatedResourceView {
  return {
    modelLabel: input.modelId,
    machineLabel: input.agentNode.kind === "machine" ? input.agentNode.machineId : null,
    skills: input.skillIds.map((id) => ({ id, label: id })),
    mcps: input.mcpIds.map((id) => ({ id, label: id })),
    knowledgeBases: [],
    siteApps: input.siteAppIds.map((id) => ({ id, label: id, remoteAppId: null })),
  };
}

/** 解析关联资源标签；任何解析异常都降级为 ID 标签，保证列表接口不因展示信息失败而整体报错。 */
export async function buildAgentRelatedResourceView(
  input: AgentRelatedResourceInput,
): Promise<AgentRelatedResourceView> {
  const fallback = buildFallbackView(input);
  const db = getAgentConfigDatabase();

  try {
    const [modelLabel, machineLabel] = await Promise.all([
      resolveModelLabel(input.modelId),
      resolveMachineLabel(input.agentNode),
    ]);

    const [skillLabelMap, mcpLabelMap] = await Promise.all([
      findSkillLabelsByIds(input.skillIds),
      findMcpServerLabelsByIds(input.mcpIds),
    ]);

    const knowledgeBaseRows =
      input.knowledgeBaseIds.length > 0
        ? await db
            .select({ id: knowledgeBase.id, name: knowledgeBase.name, slug: knowledgeBase.slug })
            .from(knowledgeBase)
            .where(
              and(
                inArray(knowledgeBase.id, [...input.knowledgeBaseIds]),
                eq(knowledgeBase.organizationId, input.organizationId),
              ),
            )
        : [];
    const knowledgeBaseMap = new Map(knowledgeBaseRows.map((row) => [row.id, row]));

    const siteAppRows =
      input.siteAppIds.length > 0
        ? await db
            .select({ id: agentSiteApp.id, name: agentSiteApp.name, remoteAppId: agentSiteApp.remoteAppId })
            .from(agentSiteApp)
            .where(
              and(
                inArray(agentSiteApp.id, [...input.siteAppIds]),
                eq(agentSiteApp.organizationId, input.organizationId),
              ),
            )
        : [];
    const siteAppMap = new Map(siteAppRows.map((row) => [row.id, row]));

    return {
      modelLabel,
      machineLabel,
      skills: input.skillIds.map((id) => ({ id, label: skillLabelMap.get(id) ?? id })),
      mcps: input.mcpIds.map((id) => ({ id, label: mcpLabelMap.get(id) ?? id })),
      knowledgeBases: input.knowledgeBaseIds.map((id) => {
        const row = knowledgeBaseMap.get(id);
        return { id, label: row?.name ?? id, slug: row?.slug ?? null };
      }),
      siteApps: input.siteAppIds.map((id) => {
        const row = siteAppMap.get(id);
        return { id, label: row?.name ?? id, remoteAppId: row?.remoteAppId ?? null };
      }),
    };
  } catch {
    // 展示信息不影响业务结果：解析失败时退回全 ID 视图，与迁移前一致。
    return fallback;
  }
}
