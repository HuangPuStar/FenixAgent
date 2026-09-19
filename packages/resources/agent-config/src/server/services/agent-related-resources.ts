import { db } from "@server/db";
import { agentSiteApp, knowledgeBase, machine, mcpServer, model, provider, skill } from "@server/db/schema";
import { and, eq, inArray } from "drizzle-orm";
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
 * 跨包表（`model` / `provider` / `machine` / `skill` / `mcp_server` / `knowledge_base` /
 * `agent_site_app`）直接经 `@server/db/schema` 读取，和迁移前一致；这些表的所有权随资源包迁移
 * 属于后续任务（1.3 / 1.7），此处不引入新的抽象层。
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

/** 解析模型标签：`<provider 展示名>/<模型展示名>`；任一段缺失时退回 modelId。 */
async function resolveModelLabel(modelId: string | null): Promise<string | null> {
  if (!modelId) return null;

  const modelRows = await db
    .select({
      modelName: model.modelId,
      displayName: model.displayName,
      providerId: model.providerId,
      providerOrganizationId: model.organizationId,
    })
    .from(model)
    .where(eq(model.id, modelId))
    .limit(1);
  const modelRow = modelRows[0];

  if (modelRow) {
    const providerRows = await db
      .select({ name: provider.name, displayName: provider.displayName })
      .from(provider)
      .where(and(eq(provider.id, modelRow.providerId), eq(provider.organizationId, modelRow.providerOrganizationId)))
      .limit(1);
    const providerRow = providerRows[0];
    if (providerRow) {
      return `${providerRow.displayName ?? providerRow.name}/${modelRow.displayName ?? modelRow.modelName}`;
    }
  }

  return modelId;
}

/** 解析执行节点标签：机器名称优先，其次主机名，最后 agent 名称；机器行缺失时退回 machineId。 */
async function resolveMachineLabel(agentNode: AgentNode): Promise<string | null> {
  if (agentNode.kind !== "machine") return null;

  const machineRows = await db
    .select({ agentName: machine.agentName, name: machine.name, machineInfo: machine.machineInfo })
    .from(machine)
    .where(eq(machine.id, agentNode.machineId))
    .limit(1);
  const machineRow = machineRows[0];
  if (!machineRow) return agentNode.machineId;

  const hostname =
    machineRow.machineInfo && typeof machineRow.machineInfo === "object"
      ? ((machineRow.machineInfo as { hostname?: string }).hostname ?? "")
      : "";
  return machineRow.name || hostname || machineRow.agentName;
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

  try {
    const [modelLabel, machineLabel] = await Promise.all([
      resolveModelLabel(input.modelId),
      resolveMachineLabel(input.agentNode),
    ]);

    const [skillRows, mcpRows] = await Promise.all([
      input.skillIds.length > 0
        ? db
            .select({ id: skill.id, label: skill.name })
            .from(skill)
            .where(inArray(skill.id, [...input.skillIds]))
        : [],
      input.mcpIds.length > 0
        ? db
            .select({ id: mcpServer.id, label: mcpServer.name })
            .from(mcpServer)
            .where(inArray(mcpServer.id, [...input.mcpIds]))
        : [],
    ]);
    const skillLabelMap = new Map(skillRows.map((row) => [row.id, row.label]));
    const mcpLabelMap = new Map(mcpRows.map((row) => [row.id, row.label]));

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
