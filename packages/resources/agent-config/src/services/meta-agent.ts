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
import { agentInstanceService } from "@fenix/agent-runtime/server";
import { log } from "@fenix/logger";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import {
  buildSkillArchive,
  getGlobalSkillsDir,
  getSkillArchivePath,
  getSkillSourceDir,
  parseFrontmatter,
} from "@fenix/resource-skill/server/content";
import { getSkillServerModule, type SkillSystemRecord } from "@fenix/resource-skill/server/runtime";
import type { AuthContext } from "@server/plugins/auth";
import { getAgentConfigModule } from "../server/runtime";
import { toAgentConfigWriteData } from "../server/services/config/agent-config";

export const META_ENVIRONMENT_NAME = "meta-agent";

/** Host-bound read port keeps agent-config independent from model-management. */
export type MetaAgentModelResolver = (ctx: AuthContext) => Promise<string | null>;

let metaAgentModelResolver: MetaAgentModelResolver | undefined;

/** Registers the host's model lookup implementation during server bootstrap. */
export function setMetaAgentModelResolver(resolver: MetaAgentModelResolver | undefined): void {
  metaAgentModelResolver = resolver;
}

/** Meta Agent 系统提示词 — 约束其只能通过 API 操作，不能直接读写文件 */
const META_AGENT_PROMPT = [
  "你是 Meta Agent，一个通过 API 管理系统的运维助手。",
  "",
  "## 核心原则",
  "",
  "1. 你只能通过 **agent-platform-api** skill 提供的 API 来读写系统配置。",
  "2. 你不能使用普通的文件读写工具（read/write/edit/bash）来修改系统数据。",
  "3. 你可以使用 bash/read 来查看信息，但不能用于更改配置、创建/修改文件。",
  "4. 如果某个操作没有对应的 API，告知用户当前不支持，不要尝试绕过。",
  "",
  "## 可管理的资源",
  "",
  "通过 API 你可以：创建/编辑/删除 Skill、管理 AgentConfig、管理 MCP Server 配置、查询模型和 Provider 信息。",
  "",
  "## 工作方式",
  "",
  "收到用户请求后，先确认该操作是否可以通过 API 完成。如果可以，调用对应的 API 端点完成操作。",
].join("\n");
const META_AGENT_CONFIG_NAME = "meta";
const META_KEY_LABEL = "Meta Agent";

/** 内置 skill 目录，相对于项目根目录 */
const BUILTIN_SKILLS_DIR = ".agents/skills";

/** 内置 skill 的 metadata 标记，用于识别 meta agent 创建的 skill，避免误删用户 skill */
const META_BUILTIN_MARKER = { source: "meta-builtin" } as const;

/** 判断一条 Skill 记录是否由 meta agent 注册 */
function isMetaBuiltin(row: { metadata?: Record<string, string> }): boolean {
  return row.metadata?.source === "meta-builtin";
}

/**
 * 选择 meta Agent 应绑定的系统托管 builtin skill。
 *
 * 传进来的记录已经限定在系统托管组织内，因此不再需要额外的归属判断：系统组织里的同名 skill 就是
 * builtin 来源，业务组织中的同名 skill 根本不在这个集合里。
 */
export function selectSystemBuiltinSkillId(
  rows: readonly Pick<SkillSystemRecord, "id" | "name" | "metadata">[],
  name: string,
): string | null {
  const selected = rows.find((row) => row.name === name && isMetaBuiltin(row));
  return selected?.id ?? null;
}

/** orgId → apiKey 明文缓存，避免重复创建 */
const metaApiKeyCache = new Map<string, string>();

export interface EnsureMetaResult {
  environmentId: string;
  instanceId?: string;
  status: "created" | "reused";
  apiKey?: string;
}

/**
 * 从环境列表中查找当前用户在当前组织下的 meta-agent 环境。
 *
 * 必须按 (organizationId, userId, name) 三元组定位——meta env 是
 * 用户维度隔离的：同组织其他成员创建的 meta env 不复用，否则会被
 * `src/routes/acp/index.ts` 的 forbiddenSharedRuntime 校验拒绝（env
 * 绑定了 agentConfig 且 env.userId !== 当前用户），导致 WS 反复
 * Upgrade rejected 4003 → ACP 自动重连 → 前端"不断刷新"。
 *
 * 运行时 workspace 已由 relay-handler 按当前请求用户解析，所以
 * 用户维度隔离是干净的；这里只是把"查找"也按用户维度收敛。
 */
export async function findMetaEnvironment(ctx: AuthContext): Promise<{ id: string; name: string } | null> {
  const { environmentRepo } = await import("@fenix/agent-runtime/server");
  const envs = await environmentRepo.listByOrganizationId(ctx.organizationId);
  const meta = envs.find((e) => e.name === META_ENVIRONMENT_NAME && e.userId === ctx.userId);
  return meta ? { id: meta.id, name: meta.name } : null;
}

/** 确保环境中存在 meta agent 所需的 AgentConfig 和 Skill */
async function resolveDefaultMetaModelRef(ctx: AuthContext): Promise<string | null> {
  return (await metaAgentModelResolver?.(ctx)) ?? null;
}

/** 解析内置 SKILL.md，并把 frontmatter 与正文分离后交给统一写入流程。 */
function parseSkillFrontmatter(raw: string): { name: string; description: string; content: string } | null {
  const parsed = parseFrontmatter(raw);
  if (!parsed.metadata.name) return null;
  return {
    name: parsed.metadata.name,
    description: parsed.metadata.description ?? "",
    content: parsed.content,
  };
}

/** 扫描仓库内置 skill 源目录；这里读取的是源码模板，不是运行时组织目录。 */
function scanBuiltinSkills(): {
  name: string;
  description: string;
  content: string;
}[] {
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
      skills.push(parsed);
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
 *
 * 走 Skill 资源的系统路径（`system.*`）：这是启动期编排，没有请求主体可用，也不该伪造一个 super-admin
 * actor 去通过授权谓词。调用方因此必须自己保证 `ctx` 指向的是系统托管组织。
 */
export async function syncBuiltinSkills(ctx: AuthContext): Promise<void> {
  const { system } = getSkillServerModule();
  const organizationId = ctx.organizationId;
  const builtinSkills = scanBuiltinSkills();
  if (builtinSkills.length === 0) return;

  const builtinNames = new Set(builtinSkills.map((s) => s.name));

  // 查询该组织中由 meta agent 注册的 skill，找出需要清理的孤儿
  const allDbSkills = await system.listByOrganization(organizationId);
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
        await system.removeByName({ organizationId, name: orphan.name });
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
      const existing = await system.findByName({ organizationId, name: builtin.name });
      if (existing && !isMetaBuiltin(existing)) {
        log(
          `[meta-agent] Skipping built-in skill "${builtin.name}": user skill with same name exists (id=${existing.id})`,
        );
        continue;
      }

      const info = await system.writeDocument({
        organizationId,
        ownerUserId: ctx.userId,
        name: builtin.name,
        description: builtin.description,
        content: builtin.content,
        metadata: { ...META_BUILTIN_MARKER },
      });

      // 将 .agents/skills/{name}/ 下的额外文件（references/ 等）同步到 data/skills/{name}/
      const builtinDir = join(process.cwd(), BUILTIN_SKILLS_DIR, builtin.name);
      const targetRoot = getGlobalSkillsDir();
      const targetDir = getSkillSourceDir(targetRoot, organizationId, builtin.name);
      const extraEntries = readdirSync(builtinDir).filter((e) => e !== "SKILL.md");
      for (const extra of extraEntries) {
        const src = join(builtinDir, extra);
        const dst = join(targetDir, extra);
        cpSync(src, dst, { recursive: true, force: true });
      }

      // 有额外文件时需要重建 archive 以包含 references 等目录
      if (extraEntries.length > 0) {
        const archivePath = getSkillArchivePath(targetRoot, organizationId, builtin.name);
        await buildSkillArchive(targetDir, archivePath);
      }

      log(`[meta-agent] Synced built-in skill: ${builtin.name} (id=${info.id})`);
    } catch (err) {
      console.error(`[meta-agent] Failed to register skill ${builtin.name}:`, err);
    }
  }
}

/** 从系统 admin 组织反查 builtin 名称对应的 skill id，供后续绑定 AgentConfig 或公开设置。 */
async function listBuiltinSkillIds(_ctx: AuthContext): Promise<string[]> {
  // builtin 绑定固定来自系统 admin 组织，不从当前业务组织解析同名 skill。
  // 系统托管租户经 platform-sdk 窄契约读取，identity 在内部完成引导；resource 不得依赖 identity。
  const tenant = await getIdentityDirectory().resolveSystemTenant();
  const systemSkills = await getSkillServerModule().system.listByOrganization(tenant.organizationId);
  const skillIds: string[] = [];
  for (const builtin of scanBuiltinSkills()) {
    const skillId = selectSystemBuiltinSkillId(systemSkills, builtin.name);
    if (skillId) skillIds.push(skillId);
  }
  return skillIds;
}

/**
 * 将 builtin skill 同步到系统 admin 组织，并统一设置为公开可读。
 * 这样其他组织通过现有 public readable 机制访问，不再复制物理副本。
 */
export async function syncBuiltinSkillsToSystemAdmin(
  ctx: AuthContext,
  deps: {
    syncBuiltinSkills?: (ctx: AuthContext) => Promise<void>;
    listBuiltinSkillIds?: (ctx: AuthContext) => Promise<string[]>;
    setSkillPublicReadable?: (skillId: string) => Promise<boolean>;
  } = {},
): Promise<void> {
  const syncBuiltinSkillsFn = deps.syncBuiltinSkills ?? syncBuiltinSkills;
  const listBuiltinSkillIdsFn = deps.listBuiltinSkillIds ?? listBuiltinSkillIds;
  // 公开受众设置保留在这里，而不是塞进 writeDocument 流程里，
  // 因为“系统托管 + 全组织共享”是 builtin 编排策略，不是普通 skill 写入的默认语义。
  const setSkillPublicReadable =
    deps.setSkillPublicReadable ??
    ((skillId: string) =>
      getSkillServerModule().system.setPublicReadable({ resourceId: skillId, publicReadable: true }));

  await syncBuiltinSkillsFn(ctx);
  for (const skillId of await listBuiltinSkillIdsFn(ctx)) {
    // 设置失败意味着 builtin 只对系统组织可见，业务组织会静默看不到它；这是编排问题，必须留下痕迹。
    const applied = await setSkillPublicReadable(skillId);
    if (!applied) {
      log(`[meta-agent] Failed to set builtin skill ${skillId} public readable: resource not found`);
    }
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
  // 走领域服务而不是资源行协议层：这是启动期编排，没有请求主体，也不该伪造 actor 去通过授权谓词。
  // 名称在组织内唯一，因此按 (name, organizationId) 定位，不会跨组织命中同名 Agent。
  const { service, associations } = getAgentConfigModule();
  const locate = { name: META_AGENT_CONFIG_NAME, organizationId: ctx.organizationId };

  let agentConfig = await service.findByNameUnscoped(locate);
  if (!agentConfig) {
    const defaultModelRef = await resolveDefaultMetaModelRef(ctx);
    await service.create({
      name: META_AGENT_CONFIG_NAME,
      data: toAgentConfigWriteData({
        description: "Meta Agent — 工作流编排助手",
        modelId: defaultModelRef,
        prompt: null,
      }),
      organizationId: ctx.organizationId,
      ownerUserId: ctx.userId,
      visibility: "private",
    });
    agentConfig = await service.findByNameUnscoped(locate);
    if (!agentConfig) {
      throw new Error("Failed to create meta agent config");
    }
  }

  // 已有配置但 model 为空时，自动解析并填充默认模型
  if (!agentConfig.model?.trim()) {
    const defaultModelRef = await resolveDefaultMetaModelRef(ctx);
    if (defaultModelRef) {
      log(`[meta-agent] Auto-filling empty model for meta AgentConfig: ${defaultModelRef}`);
      await service.update({
        resourceId: agentConfig.id,
        data: toAgentConfigWriteData({ modelId: defaultModelRef }),
      });
    } else {
      log(`[meta-agent] No provider/model available to auto-fill meta AgentConfig model`);
    }
  }

  // 已有配置但 prompt 为空时，自动填充系统提示词
  if (!agentConfig.prompt?.trim()) {
    log("[meta-agent] Auto-filling system prompt for meta AgentConfig");
    await service.update({
      resourceId: agentConfig.id,
      data: toAgentConfigWriteData({ prompt: META_AGENT_PROMPT }),
    });
  }

  // 收集所有应绑定到 meta AgentConfig 的 skill ID
  const skillIds = await listBuiltinSkillIds(ctx);

  // 全量覆盖 meta AgentConfig 的 skill 绑定
  await associations.syncSkills(agentConfig.id, skillIds);
  log(`[meta-agent] Synced ${skillIds.length} skills to meta AgentConfig`);

  return agentConfig.id;
}

/**
 * 轮换调用方名下 API Key 的端口。
 *
 * 资源包不得依赖 `@fenix/identity`（ce-ee-engineering-standards §2.3），而"同名 key 只保留一把"
 * 的编排又只应在身份侧实现一处，因此由宿主注入 identity 的 `rotateCallerApiKey`。
 */
export type RotateCallerApiKey = (input: {
  readonly headers: Headers;
  readonly name: string;
  readonly expiresIn: number | null;
  readonly metadata: unknown;
}) => Promise<string>;

/** meta agent 的宿主注入依赖。 */
export interface MetaAgentDependencies {
  readonly rotateCallerApiKey?: RotateCallerApiKey;
}

/** 为 meta agent 获取或创建 API key。同一进程内缓存明文，避免重复创建。 */
async function ensureMetaApiKey(ctx: AuthContext, headers: Headers, deps: MetaAgentDependencies): Promise<string> {
  const cached = metaApiKeyCache.get(ctx.organizationId);
  if (cached) return cached;

  const rotate = deps.rotateCallerApiKey;
  // 缺失注入时直接失败：没有 key 的 meta environment 会在运行期以更难定位的方式失败。
  if (!rotate) throw new Error("meta agent 缺少 rotateCallerApiKey 注入，无法轮换 API Key");

  const apiKey = await rotate({
    headers,
    name: META_KEY_LABEL,
    expiresIn: 86400, // 1 天过期（秒），避免 key 永久残留
    metadata: { organizationId: ctx.organizationId, role: ctx.role },
  });
  metaApiKeyCache.set(ctx.organizationId, apiKey);
  return apiKey;
}

/** 查找或创建 meta environment + spawn 实例 */
export async function ensureMetaEnvironment(
  ctx: AuthContext,
  request: Request,
  deps: MetaAgentDependencies = {},
): Promise<EnsureMetaResult> {
  const agentConfigId = await ensureMetaConfig(ctx);
  const apiKey = await ensureMetaApiKey(ctx, request.headers, deps);
  // meta env 按 (organizationId, userId, name="meta-agent") 三元组隔离：
  // 每个用户有自己的 runtime environment，避免触发 acp/index.ts 的 forbiddenSharedRuntime
  // 校验（env 绑定 agentConfig 且 env.userId !== 当前用户 → 4003 → 前端反复重连刷新）。
  const existing = await findMetaEnvironment(ctx);
  if (existing) {
    try {
      const instance = await agentInstanceService.resolveInstanceForOperation({
        environmentId: existing.id,
        ownerUserId: ctx.userId,
        automaticSelection: "chat",
      });
      await agentInstanceService.ensureInstanceRuntime(instance);
      return {
        environmentId: existing.id,
        instanceId: instance.id,
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

  const { createWebEnvironment } = await import("@fenix/agent-runtime/server");
  const env = await createWebEnvironment({
    name: META_ENVIRONMENT_NAME,
    description: "Meta Agent — 工作流编排助手（自动创建）",
    agentConfigId,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
  });

  try {
    const instance = await agentInstanceService.resolveInstanceForOperation({
      environmentId: env.id,
      ownerUserId: ctx.userId,
      automaticSelection: "chat",
    });
    await agentInstanceService.ensureInstanceRuntime(instance);
    return {
      environmentId: env.id,
      instanceId: instance.id,
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
