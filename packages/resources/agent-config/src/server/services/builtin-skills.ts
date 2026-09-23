/** 启动期内置 Skill 同步：托管在系统组织并公开给其它组织，不负责 Agent 配置或实例启动。 */
import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/** 启动期系统托管主体；调用方必须保证组织是系统组织。 */
export interface BuiltinSkillContext {
  readonly organizationId: string;
  readonly userId: string;
}

const BUILTIN_SKILLS_DIR = ".agents/skills";
// 已持久化的来源标记保持不变，避免把系统托管记录误判为用户资源；不做数据迁移。
const BUILTIN_MARKER = { source: "meta-builtin" } as const;

function isSystemBuiltin(row: { metadata?: Record<string, string> }): boolean {
  return row.metadata?.source === BUILTIN_MARKER.source;
}

/** 输入集合已限定为系统组织；同名用户 Skill 不可冒充内置 Skill。 */
export function selectSystemBuiltinSkillId(
  rows: readonly Pick<SkillSystemRecord, "id" | "name" | "metadata">[],
  name: string,
): string | null {
  const selected = rows.find((row) => row.name === name && isSystemBuiltin(row));
  return selected?.id ?? null;
}

function parseSkillFrontmatter(raw: string): { name: string; description: string; content: string } | null {
  const parsed = parseFrontmatter(raw);
  if (!parsed.metadata.name) return null;
  return {
    name: parsed.metadata.name,
    description: parsed.metadata.description ?? "",
    content: parsed.content,
  };
}

/** 扫描源码模板，不读取运行时组织目录。 */
function scanBuiltinSkills(): { name: string; description: string; content: string }[] {
  const skillsDir = join(process.cwd(), BUILTIN_SKILLS_DIR);
  if (!existsSync(skillsDir)) {
    log(`[builtin-skills] Built-in skills directory not found: ${skillsDir}`);
    return [];
  }
  const skills: { name: string; description: string; content: string }[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(skillMdPath)) continue;
    try {
      const parsed = parseSkillFrontmatter(readFileSync(skillMdPath, "utf-8"));
      if (!parsed) {
        log(`[builtin-skills] Skipping ${entry.name}: no valid frontmatter`);
        continue;
      }
      skills.push(parsed);
    } catch (err) {
      log(`[builtin-skills] Failed to read skill ${entry.name}: ${err}`);
    }
  }
  return skills;
}

/** 走 Skill 系统路径，保留用户资源，仅清理系统托管的孤儿记录。 */
async function syncBuiltinSkills(ctx: BuiltinSkillContext): Promise<void> {
  const { system } = getSkillServerModule();
  const organizationId = ctx.organizationId;
  const builtinSkills = scanBuiltinSkills();
  if (builtinSkills.length === 0) return;
  const builtinNames = new Set(builtinSkills.map((s) => s.name));
  const allDbSkills = await system.listByOrganization(organizationId);
  const orphans = allDbSkills.filter((s) => isSystemBuiltin(s) && !builtinNames.has(s.name));
  for (const orphan of orphans) {
    try {
      await system.removeByName({ organizationId, name: orphan.name });
      log(`[builtin-skills] Cleaned up orphan skill: ${orphan.name} (id=${orphan.id})`);
    } catch (err) {
      console.error(`[builtin-skills] Failed to delete orphan skill ${orphan.name}:`, err);
    }
  }
  for (const builtin of builtinSkills) {
    try {
      const existing = await system.findByName({ organizationId, name: builtin.name });
      if (existing && !isSystemBuiltin(existing)) {
        log(
          `[builtin-skills] Skipping built-in skill "${builtin.name}": user skill with same name exists (id=${existing.id})`,
        );
        continue;
      }
      const info = await system.writeDocument({
        organizationId,
        ownerUserId: ctx.userId,
        name: builtin.name,
        description: builtin.description,
        content: builtin.content,
        metadata: { ...BUILTIN_MARKER },
      });
      const builtinDir = join(process.cwd(), BUILTIN_SKILLS_DIR, builtin.name);
      const targetRoot = getGlobalSkillsDir();
      const targetDir = getSkillSourceDir(targetRoot, organizationId, builtin.name);
      const extraEntries = readdirSync(builtinDir).filter((e) => e !== "SKILL.md");
      for (const extra of extraEntries) {
        cpSync(join(builtinDir, extra), join(targetDir, extra), { recursive: true, force: true });
      }
      if (extraEntries.length > 0) {
        await buildSkillArchive(targetDir, getSkillArchivePath(targetRoot, organizationId, builtin.name));
      }
      log(`[builtin-skills] Synced built-in skill: ${builtin.name} (id=${info.id})`);
    } catch (err) {
      console.error(`[builtin-skills] Failed to register skill ${builtin.name}:`, err);
    }
  }
}

async function listBuiltinSkillIds(_ctx: BuiltinSkillContext): Promise<string[]> {
  const tenant = await getIdentityDirectory().resolveSystemTenant();
  const systemSkills = await getSkillServerModule().system.listByOrganization(tenant.organizationId);
  const skillIds: string[] = [];
  for (const builtin of scanBuiltinSkills()) {
    const skillId = selectSystemBuiltinSkillId(systemSkills, builtin.name);
    if (skillId) skillIds.push(skillId);
  }
  return skillIds;
}

/** 内置资源统一托管并公开可读，业务组织不复制物理副本。 */
export async function syncBuiltinSkillsToSystemAdmin(
  ctx: BuiltinSkillContext,
  deps: {
    syncBuiltinSkills?: (ctx: BuiltinSkillContext) => Promise<void>;
    listBuiltinSkillIds?: (ctx: BuiltinSkillContext) => Promise<string[]>;
    setSkillPublicReadable?: (skillId: string) => Promise<boolean>;
  } = {},
): Promise<void> {
  const syncBuiltinSkillsFn = deps.syncBuiltinSkills ?? syncBuiltinSkills;
  const listBuiltinSkillIdsFn = deps.listBuiltinSkillIds ?? listBuiltinSkillIds;
  const setSkillPublicReadable =
    deps.setSkillPublicReadable ??
    ((skillId: string) =>
      getSkillServerModule().system.setPublicReadable({ resourceId: skillId, publicReadable: true }));
  await syncBuiltinSkillsFn(ctx);
  for (const skillId of await listBuiltinSkillIdsFn(ctx)) {
    const applied = await setSkillPublicReadable(skillId);
    if (!applied) {
      log(`[builtin-skills] Failed to set builtin skill ${skillId} public readable: resource not found`);
    }
  }
  log(`[builtin-skills] Builtin skills hosted under admin organization ${ctx.organizationId}`);
}
