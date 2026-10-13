import type { AgentKnowledgeConfig } from "@fenix/resource-knowledge/server";
import type { VisibleSkill } from "./agent-generation";
import { normalizeKnowledgeConfig } from "./config/agent-config";

/**
 * Agent 配置请求里的**关联绑定**字段 → 领域侧的数据形状与解析规则。
 *
 * 放在服务层而不是各自的协议层：`/web` 与 `/api` 两条入口都用它，绑定字段的"哪些显式出现才同步"
 * 与 Skill 名称的解析范围只能有一份实现——历史上两套路由各写一遍，改一处漏一处就会让某条入口
 * 误清空绑定或把其他组织的 Skill 名绑上去。
 *
 * **本文件不认识 actor**：请求形状的抽取（{@link readAgentBindingRequest}）与名称解析
 * （{@link resolveSkillIdentifiers}）都是显式入参的纯规则，可见 Skill 范围由 Facade 算好后传入
 * （`facades/agent-authoring-facade.ts` 是唯一持有主体的地方）。
 */

/** UUID 格式正则 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 标识符是否已经是资源 UUID。
 *
 * 调用方用它跳过"读可见范围"这一步：UUID 输入不需要名称解析，也就不该产生一次跨资源读取
 * （`facades/agent-authoring-facade.ts` 是唯一调用方）。
 */
export function isSkillIdentifier(value: string): boolean {
  return UUID_RE.test(value);
}

/** 请求里显式出现的绑定字段；字段缺席表示"不改动该绑定"。 */
export interface AgentBindingRequest {
  readonly knowledge?: AgentKnowledgeConfig | null;
  readonly skillIds?: readonly string[];
  readonly mcpIds?: readonly string[];
  readonly siteAppIds?: readonly string[];
}

/** 请求里的 ID 列表；非数组一律视为空集合（与迁移前的 `Array.isArray(...) ? ... : []` 一致）。 */
function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * 从请求数据中抽取绑定字段。
 *
 * 只在字段**存在**时产出对应键：缺失表示"不改动"，若当成清空，一次只改 prompt 的保存会把 skill /
 * MCP / 知识库绑定全部抹掉。
 */
export function readAgentBindingRequest(data: Record<string, unknown>): AgentBindingRequest {
  const request: {
    knowledge?: AgentKnowledgeConfig | null;
    skillIds?: readonly string[];
    mcpIds?: readonly string[];
    siteAppIds?: readonly string[];
  } = {};
  if (data.knowledge !== undefined) request.knowledge = normalizeKnowledgeConfig(data.knowledge);
  if (data.skillIds !== undefined) request.skillIds = toStringArray(data.skillIds);
  if (data.mcpIds !== undefined) request.mcpIds = toStringArray(data.mcpIds);
  if (data.siteAppIds !== undefined) request.siteAppIds = toStringArray(data.siteAppIds);
  return request;
}

/**
 * 请求里是否显式出现了任何一个绑定字段。
 *
 * 调用方（协议层）用它跳过"没有任何绑定要写"的保存：既不产生多余的跨资源调用，也不让"未出现绑定字段"
 * 的请求经过绑定编写路径。
 */
export function hasAgentBindings(request: AgentBindingRequest): boolean {
  return (
    request.knowledge !== undefined ||
    request.skillIds !== undefined ||
    request.mcpIds !== undefined ||
    request.siteAppIds !== undefined
  );
}

/**
 * 将 skill 标识符数组（可能是 UUID 或名称）统一解析为 UUID。
 * 模板和 AI 生成的流程可能传入 skill 名称而非 UUID，需要在此解析。
 *
 * 名称只在**给定的可见 Skill 范围**里解析：范围之外的名称解析不出 ID，绑定自然失败，不会因为知道
 * 名字就能引用不可见的 Skill。范围由 Facade 按主体算出（本函数不认识 actor）。
 */
export function resolveSkillIdentifiers(input: {
  readonly identifiers: readonly string[];
  readonly skills: readonly VisibleSkill[];
}): string[] {
  if (input.identifiers.length === 0) return [];
  if (input.identifiers.every((id) => UUID_RE.test(id))) return [...input.identifiers];

  const nameToId = new Map(input.skills.map((skill) => [skill.name.toLowerCase(), skill.id]));

  return input.identifiers
    .map((id) => {
      if (UUID_RE.test(id)) return id;
      return nameToId.get(id.toLowerCase()) ?? null;
    })
    .filter((id): id is string => Boolean(id));
}
