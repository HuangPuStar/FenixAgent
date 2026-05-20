/**
 * Meta Agent 服务层。
 *
 * 管理 meta agent 的 Environment 生命周期：
 * - 查找或创建名为 meta-agent 的 Environment（kebab-case，通过校验）
 * - 确保 meta AgentConfig 存在
 * - 确保 meta 专属 Skill 已注册并写入文件系统
 * - 按需 spawn 实例，自动创建 API key 注入环境变量
 */

import { createWebEnvironment, listEnvironmentsWithInstances } from "./environment-web";
import { spawnInstanceFromEnvironment } from "./instance";
import { upsertSkill } from "./config/skill";
import { getAgentConfig, createAgentConfig } from "./config/agent-config";
import { createApiKey } from "../auth/api-key-service";
import type { AuthContext } from "../plugins/auth";
import { META_SKILL_NAME, META_SKILL_DESCRIPTION, writeMetaSkillFile } from "./config/skill-meta-content";

export const META_ENVIRONMENT_NAME = "meta-agent";
const META_AGENT_CONFIG_NAME = "meta";
const META_KEY_LABEL = "Meta Agent";
const META_KEY_EXPIRY_MS = 3600_000; // 1 小时

export interface EnsureMetaResult {
  environmentId: string;
  instanceId?: string;
  status: "created" | "reused";
  apiKey?: string;
}

/** 从环境列表中查找名为 meta-agent 的环境 */
export async function findMetaEnvironment(ctx: AuthContext): Promise<{ id: string; name: string } | null> {
  const envs = await listEnvironmentsWithInstances(ctx.organizationId);
  const meta = envs.find((e: any) => e.name === META_ENVIRONMENT_NAME);
  return meta ? { id: meta.id, name: meta.name } : null;
}

/** 确保环境中存在 meta agent 所需的 AgentConfig 和 Skill */
async function ensureMetaConfig(ctx: AuthContext): Promise<string> {
  let agentConfig = await getAgentConfig(ctx, META_AGENT_CONFIG_NAME);
  if (!agentConfig) {
    agentConfig = await createAgentConfig(ctx, META_AGENT_CONFIG_NAME, {
      description: "Meta Agent — 工作流编排助手",
      model: null,
      prompt: null,
      steps: null,
    });
  }

  await writeMetaSkillFile();

  await upsertSkill(ctx, META_SKILL_NAME, {
    description: META_SKILL_DESCRIPTION,
    contentPath: `meta/${META_SKILL_NAME}/SKILL.md`,
    enabled: true,
    agentConfigId: agentConfig.id,
  });

  return agentConfig.id;
}

/** 为 meta agent 创建 API key（1 小时过期） */
async function createMetaApiKey(ctx: AuthContext): Promise<string> {
  const expiresAt = new Date(Date.now() + META_KEY_EXPIRY_MS);
  const { fullKey } = await createApiKey(ctx.userId, META_KEY_LABEL, ctx.organizationId, { expiresAt });
  return fullKey;
}

/** 查找或创建 meta environment + spawn 实例 */
export async function ensureMetaEnvironment(ctx: AuthContext): Promise<EnsureMetaResult> {
  const agentConfigId = await ensureMetaConfig(ctx);
  const apiKey = await createMetaApiKey(ctx);
  const extraEnv: Record<string, string> = { USER_META_API_KEY: apiKey };

  const existing = await findMetaEnvironment(ctx);
  if (existing) {
    try {
      const inst = await spawnInstanceFromEnvironment(ctx.userId, existing.id, undefined, extraEnv);
      return {
        environmentId: existing.id,
        instanceId: inst.id,
        status: "reused",
        apiKey,
      };
    } catch {
      return {
        environmentId: existing.id,
        status: "reused",
      };
    }
  }

  const env = await createWebEnvironment({
    name: META_ENVIRONMENT_NAME,
    description: "Meta Agent — 工作流编排助手（自动创建）",
    agentConfigId,
    workspacePath: process.cwd(),
    userId: ctx.userId,
    organizationId: ctx.organizationId,
  });

  try {
    const inst = await spawnInstanceFromEnvironment(ctx.userId, env.id, undefined, extraEnv);
    return {
      environmentId: env.id,
      instanceId: inst.id,
      status: "created",
      apiKey,
    };
  } catch {
    return {
      environmentId: env.id,
      status: "created",
    };
  }
}
