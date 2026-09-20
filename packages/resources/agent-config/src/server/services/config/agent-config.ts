import type { AgentKnowledgeConfig, AgentKnowledgePolicy } from "@fenix/resource-knowledge/server";
import { resolveAgentKnowledgePolicy } from "@fenix/resource-knowledge/server";
import type { AgentConfigWriteData } from "../../repositories/agent-config-resource";
import type { AgentNode } from "./types";

/**
 * Agent 配置的**纯领域校验与规范化**。
 *
 * 本文件不再接触数据库与授权：资源行的读写经 `repositories/agent-config-resource.ts`（受控读取由
 * 平台授权谓词下推），授权判断在 `facades/agent-config-facade.ts`。这里只保留可在无 DB、无 actor
 * 情况下被任何层复用的规则——协议层（`/web` 与 `/api` 两套路由）在调用 Facade 前用它做字段校验，
 * 并把请求数据规范化为领域可写的形状。
 */

/** 可由配置写入的字段；`knowledge` 不是 `agent_config` 的列（它在绑定表里），因此单独处理。 */
const AGENT_SETTABLE_FIELDS = ["model", "modelId", "prompt", "description", "extra", "agentNode", "knowledge"] as const;

export function normalizeAgentNode(input: unknown): AgentNode | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length === 0) return {};
  if (value.kind === "machine" && typeof value.machineId === "string" && value.machineId.length > 0) {
    return { kind: "machine", machineId: value.machineId };
  }
  if (value.kind === "sandbox" && typeof value.sandboxPoolId === "string" && value.sandboxPoolId.length > 0) {
    return { kind: "sandbox", sandboxPoolId: value.sandboxPoolId };
  }
  return null;
}

export function resolveAgentNode(row: { agentNode?: unknown; machineId: string | null }): AgentNode | null {
  if (row.agentNode !== null && row.agentNode !== undefined) {
    return normalizeAgentNode(row.agentNode) ?? (row.machineId ? { kind: "machine", machineId: row.machineId } : {});
  }
  return row.machineId ? { kind: "machine", machineId: row.machineId } : {};
}

/**
 * 把协议层的请求数据规范化为领域可写列集合。
 *
 * 白名单过滤 + 逐字段规范化都在这里做一次，`/web` 与 `/api` 两套路由共用，避免两边的可写字段集合
 * 慢慢分叉（历史上 `FIELD_ALIAS` 这类映射就只在其中一条路径上生效）。`knowledge` 与 `skillIds` /
 * `mcpIds` / `siteAppIds` 不属于资源行，调用方另行同步绑定表。
 */
export function toAgentConfigWriteData(data: Record<string, unknown>): AgentConfigWriteData {
  const write: {
    model?: string | null;
    modelId?: string | null;
    prompt?: string | null;
    description?: string | null;
    extra?: Record<string, unknown> | null;
    agentNode?: unknown;
  } = {};

  for (const field of AGENT_SETTABLE_FIELDS) {
    const value = data[field];
    if (value === undefined) continue;
    switch (field) {
      case "agentNode":
        write.agentNode = normalizeAgentNode(value) ?? {};
        break;
      case "extra":
        write.extra = (value ?? null) as Record<string, unknown> | null;
        break;
      case "knowledge":
        // 知识库绑定在 `agent_knowledge_binding`，不是资源行的一列。
        break;
      default:
        write[field] = (value ?? null) as string | null;
    }
  }

  return write;
}

// ────────────────────────────────────────────
// Agent Config 验证
// ────────────────────────────────────────────

type PermissionAction = "ask" | "allow" | "deny";

const BUILT_IN_AGENTS = new Set(["build", "plan", "general", "explore", "title", "summary", "compaction", "meta"]);

function isValidMode(mode: string): boolean {
  return ["primary", "subagent", "all"].includes(mode);
}

function isValidSteps(steps: number): boolean {
  return Number.isInteger(steps) && steps >= 1 && steps <= 1000;
}

/**
 * Agent 名称校验：1-64 字符，Unicode 字母、数字、空格与单连字符（不得首尾为空格/连字符，不得出现 `--`）。
 *
 * 从宿主 `@server/services/config-utils` 迁入（CE 阶段 2 任务 1.3）：宿主那支是 `/web/config/*` 的共享
 * 工具，而调用它的只剩本包（宿主自身只剩测试），继续跨包深链等于把一条校验规则挂在一个 per-资源
 * 语义的实现上——资源名规则属于资源域，随 create 路径归本包。
 */
export function isValidAgentName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= 64 &&
    !name.includes("--") &&
    /^[\p{L}0-9][\p{L}0-9 -]*[\p{L}0-9]$|^[\p{L}0-9]$/u.test(name)
  );
}

/** 校验 agent 数据字段，返回错误码或 null */
export function validateAgentData(data: Record<string, unknown>): string | null {
  if (data.agentNode !== undefined && data.agentNode !== null && !normalizeAgentNode(data.agentNode)) {
    return "INVALID_AGENT_NODE";
  }
  if (data.mode !== undefined && typeof data.mode === "string" && !isValidMode(data.mode)) return "INVALID_MODE";
  if (data.steps !== undefined && typeof data.steps === "number" && !isValidSteps(data.steps)) return "INVALID_STEPS";
  if (data.temperature !== undefined) {
    if (typeof data.temperature !== "number" || data.temperature < 0 || data.temperature > 2)
      return "INVALID_TEMPERATURE";
  }
  if (data.top_p !== undefined) {
    if (typeof data.top_p !== "number" || data.top_p < 0 || data.top_p > 1) return "INVALID_TOP_P";
  }
  if (data.topP !== undefined) {
    if (typeof data.topP !== "number" || data.topP < 0 || data.topP > 1) return "INVALID_TOP_P";
  }
  if (data.color !== undefined) {
    if (typeof data.color !== "string") return "INVALID_COLOR";
    const c = data.color;
    const PRESET_COLORS = ["primary", "secondary", "accent", "success", "warning", "error", "info"];
    const isHex = /^#[0-9a-fA-F]{6}$/.test(c);
    if (!isHex && !PRESET_COLORS.includes(c)) return "INVALID_COLOR";
  }
  if (data.permission !== undefined && data.permission !== null) {
    if (typeof data.permission === "string") return "INVALID_PERMISSION";
    if (typeof data.permission !== "object" || Array.isArray(data.permission)) return "INVALID_PERMISSION";
  }
  if (data.extra !== undefined && data.extra !== null) {
    if (typeof data.extra !== "object" || Array.isArray(data.extra)) return "INVALID_EXTRA";
  }
  if (data.knowledge !== undefined) {
    const error = validateKnowledgeConfig(data.knowledge);
    if (error) return error;
  }

  return null;
}

function validateKnowledgeConfig(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "object") return "INVALID_KNOWLEDGE";

  const config = value as Record<string, unknown>;
  if (!Array.isArray(config.knowledgeBaseIds)) {
    return "INVALID_KNOWLEDGE_BASE_IDS";
  }
  if (config.knowledgeBaseIds.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    return "INVALID_KNOWLEDGE_BASE_IDS";
  }

  if (config.policy !== undefined && config.policy !== null) {
    if (typeof config.policy !== "object") {
      return "INVALID_KNOWLEDGE_POLICY";
    }
    const policy = config.policy as Record<string, unknown>;
    if (policy.searchFirst !== undefined && typeof policy.searchFirst !== "boolean") {
      return "INVALID_KNOWLEDGE_SEARCH_FIRST";
    }
    if (
      policy.maxResults !== undefined &&
      (!Number.isInteger(policy.maxResults) || (policy.maxResults as number) < 1 || (policy.maxResults as number) > 20)
    ) {
      return "INVALID_KNOWLEDGE_MAX_RESULTS";
    }
    if (
      policy.defaultNamespaces !== undefined &&
      (!Array.isArray(policy.defaultNamespaces) ||
        policy.defaultNamespaces.some((item) => typeof item !== "string" || item.trim().length === 0))
    ) {
      return "INVALID_KNOWLEDGE_DEFAULT_NAMESPACES";
    }
  }

  return null;
}

/** 将旧 tools 格式转换为 permission 格式 */
export function toolsToPermission(tools: Record<string, boolean>): Record<string, PermissionAction> {
  const result: Record<string, PermissionAction> = {};
  for (const [key, val] of Object.entries(tools)) {
    result[key] = val ? "allow" : "deny";
  }
  return result;
}

/** 规范化 knowledge config：去重、trim */
export function normalizeKnowledgeConfig(value: unknown): AgentKnowledgeConfig | null {
  if (value == null) return null;
  const input = value as AgentKnowledgeConfig;
  return {
    knowledgeBaseIds: Array.from(
      new Set(
        (Array.isArray(input.knowledgeBaseIds) ? input.knowledgeBaseIds : [])
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ),
    policy: normalizeKnowledgePolicy(input.policy),
  };
}

function normalizeKnowledgePolicy(value: AgentKnowledgePolicy | null | undefined) {
  const policy = resolveAgentKnowledgePolicy(value);
  return {
    searchFirst: policy.searchFirst,
    maxResults: policy.maxResults,
    defaultNamespaces: policy.defaultNamespaces,
  };
}

/** 判断 agent 是否为内置 */
export function isBuiltInAgent(name: string): boolean {
  return BUILT_IN_AGENTS.has(name);
}

export { AGENT_SETTABLE_FIELDS };
