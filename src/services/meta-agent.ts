/**
 * Meta Agent 服务层。
 *
 * 管理 meta agent 的 Environment 生命周期：
 * - 查找或创建名为 meta-agent 的 Environment（kebab-case，通过校验）
 * - 确保 meta AgentConfig 存在
 * - 自动扫描并装载项目 .agents/skills/ 下的内置 Skill
 * - 每次同步时清理 DB 中已不在文件系统的孤儿 Skill
 * - 按需 spawn 实例，自动创建 API key 注入环境变量
 */

import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "@fenix/logger";
import { auth } from "../auth/better-auth";
import type { AuthContext } from "../plugins/auth";
import { spawnInstanceFromEnvironment } from "../transport/relay";
import { createAgentConfig, getAgentConfig } from "./config/agent-config";
import { syncAgentSkills } from "./config/agent-config-skill";
import { getProvider, listProviders } from "./config/provider";
import { deleteSkill, getSkill, listSkills } from "./config/skill";
import { setPublicRead } from "./resource-permission";
import { getGlobalSkillsDir, setSkill } from "./skill";
import { buildSkillArchive, getSkillArchivePath, getSkillSourceDir } from "./skill-fs";

export const META_ENVIRONMENT_NAME = "meta-agent";
const META_AGENT_CONFIG_NAME = "meta";
const META_KEY_LABEL = "Meta Agent";

/** 内置 skill 目录，相对于项目根目录 */
const BUILTIN_SKILLS_DIR = ".agents/skills";

/** 内置 skill 的 metadata 标记，用于识别 meta agent 创建的 skill，避免误删用户 skill */
const META_BUILTIN_MARKER = { source: "meta-builtin" } as const;

/** 判断一个 DB skill 行是否由 meta agent 注册 */
function isMetaBuiltin(row: { metadata: unknown }): boolean {
  if (!row.metadata || typeof row.metadata !== "object") return false;
  return (row.metadata as Record<string, string>).source === "meta-builtin";
}

/** orgId → apiKey 明文缓存，避免重复创建 */
const metaApiKeyCache = new Map<string, string>();

export interface EnsureMetaResult {
  environmentId: string;
  instanceId?: string;
  status: "created" | "reused";
  apiKey?: string;
}

/** 从环境列表中查找名为 meta-agent 的环境 */
export async function findMetaEnvironment(ctx: AuthContext): Promise<{ id: string; name: string } | null> {
  const { listEnvironmentsWithInstances } = await import("./environment-web");
  const envs = await listEnvironmentsWithInstances(ctx.organizationId);
  // biome-ignore lint/suspicious/noExplicitAny: environment list items have dynamic shape
  const meta = envs.find((e: any) => e.name === META_ENVIRONMENT_NAME);
  return meta ? { id: meta.id, name: meta.name } : null;
}

/** 确保环境中存在 meta agent 所需的 AgentConfig 和 Skill */
async function resolveDefaultMetaModelRef(ctx: AuthContext): Promise<string | null> {
  const providers = await listProviders(ctx);
  for (const provider of providers) {
    const providerKey = provider.resourceAccess?.resourceKey ?? provider.name;
    const detail = await getProvider(ctx, providerKey);
    const firstModel = detail?.models?.[0];
    if (!firstModel) continue;
    return provider.resourceAccess?.ownership === "external"
      ? `${provider.resourceAccess.resourceKey}/${firstModel.modelId}`
      : `${provider.name}/${firstModel.modelId}`;
  }
  return null;
}

/** 解析内置 SKILL.md 的最小 frontmatter；这里只提取同步阶段真正需要的字段。 */
function parseSkillFrontmatter(raw: string): { name: string; description: string } | null {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const frontmatter = match[1];
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  if (!nameMatch) return null;
  // description 可能是多行（| 前缀），取第一行作为摘要
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  // 去掉 YAML 双引号包裹，与 skill-fs.ts parseFrontmatter 保持一致
  const unquote = (v: string) => v.trim().replace(/^"(.*)"$/, "$1");
  return {
    name: unquote(nameMatch[1]),
    description: descMatch ? unquote(descMatch[1]) : "",
  };
}

/** 扫描仓库内置 skill 源目录；这里读取的是源码模板，不是运行时组织目录。 */
function scanBuiltinSkills(): { name: string; description: string; content: string }[] {
  const skillsDir = join(process.cwd(), BUILTIN_SKILLS_DIR);
  if (!existsSync(skillsDir)) {
    log(`[meta-agent] Built-in skills directory not found: ${skillsDir}`);
    return [];
  }

  const skills: { name: string; description: string; content: string }[] = [];
  const entries = readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;

    try {
      const raw = readFileSync(skillMdPath, "utf-8");
      const parsed = parseSkillFrontmatter(raw);
      if (!parsed) {
        log(`[meta-agent] Skipping ${entry.name}: no valid frontmatter`);
        continue;
      }
      skills.push({ ...parsed, content: raw });
    } catch (err) {
      log(`[meta-agent] Failed to read skill ${entry.name}: ${err}`);
    }
  }

  return skills;
}

/**
 * 同步内置 skill 到 PG + 文件系统（`data/skills/`）。
 *
 * 将 `.agents/skills/` 下的内置 skill 同步到指定组织。
 * 该函数只负责“把 builtin 写进目标组织”，不负责启动期的系统级编排。
 */
export async function syncBuiltinSkills(ctx: AuthContext): Promise<void> {
  const builtinSkills = scanBuiltinSkills();
  if (builtinSkills.length === 0) return;

  const builtinNames = new Set(builtinSkills.map((s) => s.name));

  // 查询 DB 中由 meta agent 注册的 skill，找出需要清理的孤儿
  const allDbSkills = await listSkills(ctx);
  const orphans = allDbSkills.filter(
    (s) =>
      // 只清理 meta agent 自己注册的（通过 metadata.source 标记识别）
      // 绝不触碰用户手动创建的 skill
      isMetaBuiltin(s) && !builtinNames.has(s.name),
  );

  // 清理孤儿 skill
  if (orphans.length > 0) {
    for (const orphan of orphans) {
      try {
        await deleteSkill(ctx, orphan.name);
        log(`[meta-agent] Cleaned up orphan skill: ${orphan.name} (id=${orphan.id})`);
      } catch (err) {
        console.error(`[meta-agent] Failed to delete orphan skill ${orphan.name}:`, err);
      }
    }
  }

  // 注册/更新当前文件系统中的内置 skill
  for (const builtin of builtinSkills) {
    try {
      // 检查是否已有同名用户 skill，避免覆写
      const existing = await getSkill(ctx, builtin.name);
      if (existing && !isMetaBuiltin(existing)) {
        log(
          `[meta-agent] Skipping built-in skill "${builtin.name}": user skill with same name exists (id=${existing.id})`,
        );
        continue;
      }

      const info = await setSkill(ctx, builtin.name, {
        description: builtin.description,
        content: builtin.content,
        metadata: { ...META_BUILTIN_MARKER },
      });

      // 将 .agents/skills/{name}/ 下的额外文件（references/ 等）同步到 data/skills/{name}/
      const builtinDir = join(process.cwd(), BUILTIN_SKILLS_DIR, builtin.name);
      const targetRoot = getGlobalSkillsDir();
      const targetDir = getSkillSourceDir(targetRoot, ctx.organizationId, builtin.name);
      const extraEntries = readdirSync(builtinDir).filter((e) => e !== "SKILL.md");
      for (const extra of extraEntries) {
        const src = join(builtinDir, extra);
        const dst = join(targetDir, extra);
        cpSync(src, dst, { recursive: true, force: true });
      }

      // 有额外文件时需要重建 archive 以包含 references 等目录
      if (extraEntries.length > 0) {
        const archivePath = getSkillArchivePath(targetRoot, ctx.organizationId, builtin.name);
        await buildSkillArchive(targetDir, archivePath);
      }

      log(`[meta-agent] Synced built-in skill: ${builtin.name} (id=${info.id})`);
    } catch (err) {
      console.error(`[meta-agent] Failed to register skill ${builtin.name}:`, err);
    }
  }
}

/** 将当前组织下已同步的 builtin 名称反查成 skill id，供后续绑定 AgentConfig 或公开设置。 */
async function listBuiltinSkillIds(ctx: AuthContext): Promise<string[]> {
  const skillIds: string[] = [];
  for (const builtin of scanBuiltinSkills()) {
    const existing = await getSkill(ctx, builtin.name);
    if (existing?.id) {
      skillIds.push(existing.id);
    }
  }
  return skillIds;
}

/**
 * 将 builtin skill 同步到系统 admin 组织，并统一设置为公开可读。
 * 这样其他组织通过现有 external/public readable 机制访问，不再复制物理副本。
 */
export async function syncBuiltinSkillsToSystemAdmin(
  ctx: AuthContext,
  deps: {
    syncBuiltinSkills?: (ctx: AuthContext) => Promise<void>;
    listBuiltinSkillIds?: (ctx: AuthContext) => Promise<string[]>;
    setSkillPublicReadable?: (skillId: string) => Promise<void>;
  } = {},
): Promise<void> {
  const syncBuiltinSkillsFn = deps.syncBuiltinSkills ?? syncBuiltinSkills;
  const listBuiltinSkillIdsFn = deps.listBuiltinSkillIds ?? listBuiltinSkillIds;
  // 公开读设置保留在这里，而不是塞进 setSkill 流程里，
  // 因为“系统托管 + 全组织共享”是 builtin 编排策略，不是普通 skill 写入的默认语义。
  const setSkillPublicReadable =
    deps.setSkillPublicReadable ??
    ((skillId: string) => setPublicRead(ctx, "skill", ctx.organizationId, skillId, true));

  await syncBuiltinSkillsFn(ctx);
  for (const skillId of await listBuiltinSkillIdsFn(ctx)) {
    await setSkillPublicReadable(skillId);
  }
  log(`[meta-agent] Builtin skills hosted under admin organization ${ctx.organizationId}`);
}

/**
 * 收集当前组织可读的 builtin skill 并绑定到 meta AgentConfig。
 * builtin skill 统一托管在系统 admin 组织下，这里只做读取与绑定，不再为业务组织写本地副本。
 *
 * 这意味着：
 * - 系统 admin 组织会绑定本地托管的 builtin skill
 * - 业务组织只会绑定“通过公开读可见”的 external skill
 * - `ensureMetaConfig()` 不再承担 builtin 物理同步职责，避免重新回到每组织复制一份的旧模型
 * 返回 meta AgentConfig ID。
 */
async function ensureMetaConfig(ctx: AuthContext): Promise<string> {
  let agentConfig = await getAgentConfig(ctx, META_AGENT_CONFIG_NAME);
  if (!agentConfig) {
    const defaultModelRef = await resolveDefaultMetaModelRef(ctx);
    await createAgentConfig(ctx, META_AGENT_CONFIG_NAME, {
      description: "Meta Agent — 工作流编排助手",
      model: defaultModelRef,
      prompt: null,
      steps: null,
    });
    agentConfig = await getAgentConfig(ctx, META_AGENT_CONFIG_NAME);
    if (!agentConfig) {
      throw new Error("Failed to create meta agent config");
    }
  }

  // 收集所有应绑定到 meta AgentConfig 的 skill ID
  const skillIds = await listBuiltinSkillIds(ctx);

  // 全量覆盖 meta AgentConfig 的 skill 绑定
  await syncAgentSkills(agentConfig.id, skillIds);
  log(`[meta-agent] Synced ${skillIds.length} skills to meta AgentConfig`);

  return agentConfig.id;
}

/** 为 meta agent 获取或创建 API key。同一进程内缓存明文，避免重复创建。 */
async function ensureMetaApiKey(ctx: AuthContext, headers: Headers): Promise<string> {
  const cached = metaApiKeyCache.get(ctx.organizationId);
  if (cached) return cached;

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
  const apiKey = result?.key ?? result?.fullKey ?? "";
  metaApiKeyCache.set(ctx.organizationId, apiKey);
  return apiKey;
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

  const { createWebEnvironment } = await import("./environment-web");
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
