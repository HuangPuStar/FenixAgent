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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { log } from "@fenix/logger";
import { auth } from "../auth/better-auth";
import type { AuthContext } from "../plugins/auth";
import { spawnInstanceFromEnvironment } from "../transport/relay";
import { createAgentConfig, getAgentConfig } from "./config/agent-config";
import { syncAgentSkills } from "./config/agent-config-skill";
import { getProvider, listProviders } from "./config/provider";
import { deleteSkill, getSkill, listSkills, upsertSkill } from "./config/skill";
import { importSkillDirectories } from "./skill";
import type { UploadSkillFile } from "./skill-fs";

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

/** 解析 SKILL.md 的 frontmatter，提取 name 和 description */
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

/** 递归扫描目录下所有文件，返回相对路径 */
function collectFiles(dir: string, base = dir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath, base));
    } else {
      results.push(relative(base, fullPath));
    }
  }
  return results;
}

/** 扫描内置 skill 目录，返回每个 skill 的完整文件列表 */
function scanBuiltinSkills(): { name: string; description: string; files: UploadSkillFile[] }[] {
  const skillsDir = join(process.cwd(), BUILTIN_SKILLS_DIR);
  if (!existsSync(skillsDir)) {
    log(`[meta-agent] Built-in skills directory not found: ${skillsDir}`);
    return [];
  }

  const skills: { name: string; description: string; files: UploadSkillFile[] }[] = [];
  const entries = readdirSync(skillsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsDir, entry.name);
    const skillMdPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;

    try {
      const raw = readFileSync(skillMdPath, "utf-8");
      const parsed = parseSkillFrontmatter(raw);
      if (!parsed) {
        log(`[meta-agent] Skipping ${entry.name}: no valid frontmatter`);
        continue;
      }

      const relPaths = collectFiles(skillDir);
      const files: UploadSkillFile[] = relPaths.map((relPath) => ({
        skillName: parsed.name,
        relativePath: relPath,
        content: readFileSync(join(skillDir, relPath), "utf-8"),
      }));

      skills.push({ ...parsed, files });
    } catch (err) {
      log(`[meta-agent] Failed to read skill ${entry.name}: ${err}`);
    }
  }

  return skills;
}

/**
 * 确保内置 skill 已注册到 DB + 文件系统，并绑定到 meta AgentConfig。
 * 自动清理文件系统中已移除的孤儿 skill。
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

  // 扫描当前文件系统中的内置 skill
  const builtinSkills = scanBuiltinSkills();
  log(`[meta-agent] scanBuiltinSkills: cwd=${process.cwd()}, found=${builtinSkills.length} skills`);
  const builtinNames = new Set(builtinSkills.map((s) => s.name));

  // 查询 DB 中由 meta agent 注册的 skill，找出需要清理的孤儿
  const allDbSkills = await listSkills(ctx);
  const orphans = allDbSkills.filter(
    (s) =>
      // 只清理 meta agent 自己注册的（通过 metadata.source 标记识别）
      // 绝不触碰用户手动创建的 skill
      isMetaBuiltin(s) && !builtinNames.has(s.name),
  );

  // 清理孤儿 skill：先从 AgentConfig 解绑（syncAgentSkills 会全量覆盖），再删 DB 行
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

  // 注册/更新当前文件系统中的内置 skill（完整文件，包含 references 等）
  const skillIds: string[] = [];
  const allFiles: UploadSkillFile[] = [];
  for (const builtin of builtinSkills) {
    // 检查是否已有同名用户 skill，避免覆写
    const existing = await getSkill(ctx, builtin.name);
    if (existing && !isMetaBuiltin(existing)) {
      log(
        `[meta-agent] Skipping built-in skill "${builtin.name}": user skill with same name exists (id=${existing.id})`,
      );
      continue;
    }
    log(
      `[meta-agent] Queuing built-in skill "${builtin.name}": ${builtin.files.length} files, existing=${!!existing}, isMetaBuiltin=${existing ? isMetaBuiltin(existing) : "N/A"}`,
    );
    allFiles.push(...builtin.files);
  }

  if (allFiles.length > 0) {
    try {
      const result = await importSkillDirectories(ctx, allFiles, "overwrite");
      log(
        `[meta-agent] importSkillDirectories result: imported=${result.imported.map((i) => i.name).join(",")}, skipped=${result.skipped.join(",")}`,
      );
      const importedNames = new Set(result.imported.map((i) => i.name));
      for (const imported of result.imported) {
        log(`[meta-agent] Registered built-in skill: ${imported.name} (path=${imported.path})`);
      }
      // 收集导入成功的 skill ID，并补上 meta-builtin metadata 标记
      for (const name of importedNames) {
        const row = await getSkill(ctx, name);
        if (row) {
          skillIds.push(row.id);
          // importSkillDirectories 不传 metadata，需要补上标记用于孤儿检测
          await upsertSkill(ctx, name, {
            description: row.description ?? "",
            metadata: { ...META_BUILTIN_MARKER },
          }).catch((e) => {
            console.error(`[meta-agent] Failed to mark meta-builtin for ${name}:`, e);
          });
        }
      }
    } catch (err) {
      console.error("[meta-agent] Failed to import built-in skills:", err);
    }
  }

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
