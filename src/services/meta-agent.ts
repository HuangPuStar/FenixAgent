/**
 * Meta Agent 服务层。
 *
 * 管理 meta agent 的 Environment 生命周期：
 * - 查找或创建名为 meta-agent 的 Environment（kebab-case，通过校验）
 * - 确保 meta AgentConfig 存在
 * - 确保 meta 专属 Skill 已注册并写入文件系统
 * - 按需 spawn 实例，自动创建 API key 注入环境变量
 */

import { auth } from "../auth/better-auth";
import type { AuthContext } from "../plugins/auth";
import { spawnInstanceFromEnvironment } from "../transport/relay";
import { createAgentConfig, getAgentConfig } from "./config/agent-config";
import { upsertSkill } from "./config/skill";
import { META_SKILL_DESCRIPTION, META_SKILL_NAME, writeMetaSkillFile } from "./config/skill-meta-content";
import { createWebEnvironment, listEnvironmentsWithInstances } from "./environment-web";

export const META_ENVIRONMENT_NAME = "meta-agent";
const META_AGENT_CONFIG_NAME = "meta";
const META_KEY_LABEL = "Meta Agent";
const _META_KEY_EXPIRY_MS = 3600_000; // 1 小时

export interface EnsureMetaResult {
  environmentId: string;
  instanceId?: string;
  status: "created" | "reused";
  apiKey?: string;
}

/** 从环境列表中查找名为 meta-agent 的环境 */
export async function findMetaEnvironment(ctx: AuthContext): Promise<{ id: string; name: string } | null> {
  const envs = await listEnvironmentsWithInstances(ctx.organizationId);
  // biome-ignore lint/suspicious/noExplicitAny: environment list items have dynamic shape
  const meta = envs.find((e: any) => e.name === META_ENVIRONMENT_NAME);
  return meta ? { id: meta.id, name: meta.name } : null;
}

/** 确保环境中存在 meta agent 所需的 AgentConfig 和 Skill */
async function ensureMetaConfig(ctx: AuthContext): Promise<string> {
  let agentConfig = await getAgentConfig(ctx, META_AGENT_CONFIG_NAME);
  if (!agentConfig) {
    await createAgentConfig(ctx, META_AGENT_CONFIG_NAME, {
      description: "Meta Agent — 工作流编排助手",
      model: null,
      prompt: null,
      steps: null,
    });
    agentConfig = await getAgentConfig(ctx, META_AGENT_CONFIG_NAME);
    if (!agentConfig) {
      throw new Error("Failed to create meta agent config");
    }
  }

  await writeMetaSkillFile();

  await upsertSkill(ctx, META_SKILL_NAME, {
    description: META_SKILL_DESCRIPTION,
    contentPath: `meta/${META_SKILL_NAME}/SKILL.md`,
  });

  return agentConfig.id;
}

/** 为 meta agent 获取或创建 API key。先删除所有同名旧 key，再创建唯一一个。 */
async function ensureMetaApiKey(ctx: AuthContext, headers: Headers): Promise<string> {
  // 删除所有同名旧 key，避免累积
  // biome-ignore lint/suspicious/noExplicitAny: better-auth listApiKeys return type is untyped
  const listResult: any = await (auth.api as any).listApiKeys({ headers });
  const existingKeys: Array<{ id: string; name?: string }> =
    listResult?.apiKeys ?? (Array.isArray(listResult) ? listResult : []);
  for (const old of existingKeys.filter((k) => k.name === META_KEY_LABEL)) {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: better-auth deleteApiKey return type is untyped
      await (auth.api as any).deleteApiKey({ body: { id: old.id }, headers });
    } catch {
      // 旧 key 删除失败不阻断
    }
  }

  // 创建新 key
  // biome-ignore lint/suspicious/noExplicitAny: better-auth createApiKey return type is untyped
  const result: any = await (auth.api as any).createApiKey({
    body: {
      name: META_KEY_LABEL,
      prefix: "rcs_",
      expiresIn: null,
      metadata: { organizationId: ctx.organizationId, role: ctx.role },
    },
    headers,
  });
  return result?.key ?? result?.fullKey ?? "";
}

/** 查找或创建 meta environment + spawn 实例 */
export async function ensureMetaEnvironment(ctx: AuthContext, request: Request): Promise<EnsureMetaResult> {
  const agentConfigId = await ensureMetaConfig(ctx);
  const apiKey = await ensureMetaApiKey(ctx, request.headers);
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
