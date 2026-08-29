import { z } from "zod/v4";
import { type AgentNodeSelection, agentNodeToSelection, selectionToAgentNode } from "../../../lib/agent-node";
import { getMcpDisplayName, getMcpKey } from "../../../lib/mcp-resource-access";
import type { AgentDetail, ModelEntry, ResourceAccess } from "../../../types/config";
import type { KnowledgeBaseInfo } from "../../../types/knowledge";

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  skills: string[];
}

export interface AgentRelatedResources {
  modelLabel?: string | null;
  machineLabel?: string | null;
  skills?: Array<{ id: string; label: string }>;
  mcps?: Array<{ id: string; label: string }>;
  knowledgeBases?: Array<{ id: string; label: string; slug?: string | null }>;
  siteApps?: Array<{ id: string; label: string; remoteAppId: string | null }>;
}

export interface AgentEditorOption {
  id: string;
  label: string;
  description?: string;
  meta?: string;
  unavailable?: boolean;
}

export interface AgentModelOption {
  value: string;
  label: string;
}

export interface AgentMcpOption {
  id: string;
  key: string;
  name: string;
  label: string;
  resourceAccess?: ResourceAccess;
}

export interface AgentEditorValues {
  name: string;
  modelId: string;
  prompt: string;
  description: string;
  skillIds: string[];
  mcpIds: string[];
  siteAppIds: string[];
  knowledgeBaseIds: string[];
  defaultNamespaces: string;
  searchFirst: boolean;
  maxResults: string;
  agentNode: AgentNodeSelection;
  enableMemory: boolean;
  publicReadable: boolean;
  extra: string;
}

function isJsonObject(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** Agent 编辑器的字段校验；错误文案在视图边界转换为 i18n 文案。 */
export const agentEditorSchema = z.object({
  name: z.string(),
  modelId: z.string(),
  prompt: z.string(),
  description: z.string(),
  skillIds: z.array(z.string()),
  mcpIds: z.array(z.string()),
  siteAppIds: z.array(z.string()),
  knowledgeBaseIds: z.array(z.string()),
  defaultNamespaces: z.string(),
  searchFirst: z.boolean(),
  maxResults: z.string().refine((value) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 20),
  agentNode: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("default") }),
    z.object({ kind: z.literal("machine"), machineId: z.string().min(1) }),
    z.object({ kind: z.literal("sandbox"), sandboxPoolId: z.string().min(1) }),
  ]),
  enableMemory: z.boolean(),
  publicReadable: z.boolean(),
  extra: z.string().refine(isJsonObject),
});

/** 创建态默认值独立生成，避免不同编辑器实例共享可变数组。 */
export function createAgentEditorDefaults(defaultName = ""): AgentEditorValues {
  return {
    name: defaultName,
    modelId: "",
    prompt: "",
    description: "",
    skillIds: [],
    mcpIds: [],
    siteAppIds: [],
    knowledgeBaseIds: [],
    defaultNamespaces: "",
    searchFirst: true,
    maxResults: "5",
    agentNode: { kind: "default" },
    enableMemory: false,
    publicReadable: false,
    extra: "",
  };
}

/** 将协议详情转换为独立表单模型，所有缺省值都在边界处收敛。 */
export function agentDetailToEditorValues(detail: AgentDetail): AgentEditorValues {
  return {
    name: detail.name,
    modelId: detail.modelId ?? "",
    prompt: detail.prompt ?? "",
    description: detail.description ?? "",
    skillIds: detail.skillIds ?? [],
    mcpIds: detail.mcpIds ?? [],
    siteAppIds: detail.siteAppIds ?? [],
    knowledgeBaseIds: detail.knowledge?.knowledgeBaseIds ?? [],
    defaultNamespaces: (detail.knowledge?.policy?.defaultNamespaces ?? []).join("\n"),
    searchFirst: detail.knowledge?.policy?.searchFirst ?? true,
    maxResults: String(detail.knowledge?.policy?.maxResults ?? 5),
    agentNode: agentNodeToSelection(detail.agentNode),
    enableMemory: detail.enableMemory ?? false,
    publicReadable: detail.resourceAccess?.publicReadable ?? false,
    extra: detail.extra ? JSON.stringify(detail.extra, null, 2) : "",
  };
}

export const AGENT_EDITOR_PAGE_SIZE = 50;

/** 所有关闭来源（包括 Escape）共用同一草稿保护判断。 */
export function shouldConfirmAgentEditorClose(isDirty: boolean, readOnly: boolean): boolean {
  return isDirty && !readOnly;
}

/** 将大数据选择器限制为单页 DOM，同时保留完整匹配总量。 */
export function paginateAgentEditorOptions<T>(options: T[], page: number, pageSize = AGENT_EDITOR_PAGE_SIZE) {
  const pageCount = Math.max(1, Math.ceil(options.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  return {
    items: options.slice(safePage * pageSize, (safePage + 1) * pageSize),
    page: safePage,
    pageCount,
    total: options.length,
  };
}

/** 构建保存 DTO；更新态显式用 null 表达清空，创建态则省略空可选字段。 */
export function buildAgentEditorPayload(values: AgentEditorValues, mode: "create" | "edit") {
  const payload: Record<string, unknown> = {
    knowledge: {
      knowledgeBaseIds: values.knowledgeBaseIds,
      policy: {
        searchFirst: values.searchFirst,
        maxResults: Number(values.maxResults),
        defaultNamespaces: values.defaultNamespaces
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean),
      },
    },
    skillIds: values.skillIds,
    mcpIds: values.mcpIds,
    siteAppIds: values.siteAppIds,
    agentNode: selectionToAgentNode(values.agentNode),
    publicReadable: values.publicReadable,
    enableMemory: values.enableMemory,
  };
  if (mode === "edit") {
    payload.modelId = values.modelId || null;
    payload.prompt = values.prompt || null;
    payload.description = values.description || null;
    payload.extra = values.extra.trim() ? JSON.parse(values.extra) : null;
  } else {
    if (values.modelId) payload.modelId = values.modelId;
    if (values.prompt) payload.prompt = values.prompt;
    if (values.description) payload.description = values.description;
    if (values.extra.trim()) payload.extra = JSON.parse(values.extra);
  }
  return payload;
}

/** 模型选项始终使用数据库 UUID，展示标签保留 provider 来源组织。 */
export function mapModelOptions(models: ModelEntry[]): AgentModelOption[] {
  return models.map((model) => {
    const source = model.providerResourceAccess?.sourceOrganizationName;
    const provider = source ? `${source}/${model.providerDisplayName}` : model.providerDisplayName;
    return { value: model.id, label: `${provider}/${model.displayName}` };
  });
}

/** MCP 选项过滤显式禁用项，同时保留稳定 ID 与共享来源标签。 */
export function mapMcpOptions(
  servers: Array<{ id: string; name: string; enabled?: boolean; resourceAccess?: ResourceAccess }>,
): AgentMcpOption[] {
  return servers
    .filter((server) => server.enabled !== false)
    .map((server) => ({
      id: server.id,
      key: getMcpKey(server),
      name: server.name,
      label: getMcpDisplayName(server),
      resourceAccess: server.resourceAccess,
    }));
}

/** 合并当前不可见但已绑定的资源，防止打开编辑器时静默丢失关联。 */
export function mergeSelectedOptions(
  options: AgentEditorOption[],
  related: Array<{ id: string; label: string }> | undefined,
): AgentEditorOption[] {
  if (!related?.length) return options;
  const visible = new Set(options.map((option) => option.id));
  return [
    ...options,
    ...related.filter((item) => !visible.has(item.id)).map((item) => ({ ...item, unavailable: true })),
  ];
}

/** 保存前仅过滤服务端最新完整知识库列表中已删除或失权的关联。 */
export function filterValidKnowledgeIds(selectedIds: string[], options: Pick<KnowledgeBaseInfo, "id">[]) {
  const valid = new Set(options.map((item) => item.id));
  return selectedIds.filter((id) => valid.has(id));
}
