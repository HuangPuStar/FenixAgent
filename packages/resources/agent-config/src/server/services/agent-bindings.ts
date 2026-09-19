import type { ActorContext } from "@fenix/platform-sdk";
import type { AgentKnowledgeConfig } from "@fenix/resource-knowledge/server";
import { getAgentConfigModule } from "../runtime";
import { normalizeKnowledgeConfig } from "./config/agent-config";
import { listVisibleSkills } from "./skill-directory";

/**
 * Agent 配置请求里的**关联绑定**字段 → 绑定表写入。
 *
 * 放在服务层而不是各自的协议层：`/web` 与 `/api` 两条入口都用它，绑定字段的"哪些显式出现才同步"
 * 与 Skill 名称的解析范围只能有一份实现——历史上两套路由各写一遍，改一处漏一处就会让某条入口
 * 误清空绑定或把其他组织的 Skill 名绑上去。
 *
 * 与 `agent-associations.ts` 的分工：那边是绑定表的读写门面（不认识请求数据），这边只负责把请求
 * 形状翻译成绑定写入。授权判断不属于本模块——`ActorContext` 只用来限定 Skill 名称的解析范围。
 */

/** UUID 格式正则 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * 将 skill 标识符数组（可能是 UUID 或名称）统一解析为 UUID。
 * 模板和 AI 生成的流程可能传入 skill 名称而非 UUID，需要在此解析。
 *
 * 名称只在**当前主体可见**的 Skill 里解析：不可见的名称解析不出 ID，绑定自然失败，不会因为知道名字
 * 就能引用其他组织的资源。
 */
export async function resolveSkillIds(actor: ActorContext, identifiers: readonly string[]): Promise<string[]> {
  if (identifiers.length === 0) return [];
  if (identifiers.every((id) => UUID_RE.test(id))) return [...identifiers];

  const skills = await listVisibleSkills(actor);
  const nameToId = new Map(skills.map((skill) => [skill.name.toLowerCase(), skill.id]));

  return identifiers
    .map((id) => {
      if (UUID_RE.test(id)) return id;
      return nameToId.get(id.toLowerCase()) ?? null;
    })
    .filter((id): id is string => Boolean(id));
}

/** 把请求里的绑定写入绑定表；未出现的字段保持原样。 */
export async function applyAgentBindings(input: {
  readonly agentConfigId: string;
  readonly request: AgentBindingRequest;
  readonly actor: ActorContext;
}): Promise<void> {
  const { associations } = getAgentConfigModule();
  if (input.request.knowledge !== undefined) {
    await associations.syncKnowledge(input.agentConfigId, input.request.knowledge);
  }
  if (input.request.skillIds !== undefined) {
    await associations.syncSkills(input.agentConfigId, await resolveSkillIds(input.actor, input.request.skillIds));
  }
  if (input.request.mcpIds !== undefined) {
    await associations.syncMcps(input.agentConfigId, input.request.mcpIds);
  }
  if (input.request.siteAppIds !== undefined) {
    await associations.syncSiteApps(input.agentConfigId, input.request.siteAppIds);
  }
}
