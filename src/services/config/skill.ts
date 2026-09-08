import { createLogger } from "@fenix/logger";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { skill } from "../../db/schema";
import type { AuthContext } from "../../plugins/auth";
import {
  assertInternalWritable,
  buildExternalPublicReadMap,
  canReadResource,
  decorateResourceAccess,
  listReadableResourceRefs,
  setPublicRead,
} from "../resource-permission";
import type { SkillConfigRowWithAccess, SkillSetOptions, SkillUpsertData } from "./types";

const logger = createLogger("config-skill");

// ────────────────────────────────────────────
// Skill 操作（全局技能库）
// ────────────────────────────────────────────

type SkillConfigRow = Omit<SkillConfigRowWithAccess, "resourceAccess">;

function parseResourceKey(resourceKey: string) {
  const slashIndex = resourceKey.indexOf("/");
  if (slashIndex <= 0 || slashIndex === resourceKey.length - 1) return null;
  return {
    sourceOrganizationId: resourceKey.slice(0, slashIndex),
    resourceUid: resourceKey.slice(slashIndex + 1),
  };
}

async function listExternalSkills(ctx: AuthContext): Promise<{
  rows: SkillConfigRow[];
  publicReadMap: Map<string, boolean>;
}> {
  const refs = await listReadableResourceRefs(ctx, "skill");
  const ids = refs.map((ref) => ref.resourceId);
  if (ids.length === 0) return { rows: [], publicReadMap: new Map() };

  const rows = (await db.select().from(skill).where(inArray(skill.id, ids))) as SkillConfigRow[];
  const refKeys = new Set(refs.map((ref) => `${ref.organizationId}/${ref.resourceId}`));
  return {
    rows: rows.filter((row) => refKeys.has(`${row.organizationId}/${row.id}`)),
    publicReadMap: buildExternalPublicReadMap(refs),
  };
}

export async function listSkills(ctx: AuthContext): Promise<SkillConfigRowWithAccess[]> {
  const internal = (await db
    .select()
    .from(skill)
    .where(eq(skill.organizationId, ctx.organizationId))
    .orderBy(desc(skill.createdAt))) as SkillConfigRow[];
  const external = await listExternalSkills(ctx);
  return decorateResourceAccess(ctx, "skill", [...internal, ...external.rows], external.publicReadMap);
}

export async function getSkill(ctx: AuthContext, name: string): Promise<SkillConfigRowWithAccess | null> {
  const rows = await db
    .select()
    .from(skill)
    .where(and(eq(skill.organizationId, ctx.organizationId), eq(skill.name, name)))
    .limit(1);
  const internal = (rows[0] ?? null) as SkillConfigRow | null;
  if (internal) {
    const [decorated] = await decorateResourceAccess(ctx, "skill", [internal]);
    return decorated;
  }

  const external = await listExternalSkills(ctx);
  const externalRow = external.rows.find((row) => row.name === name);
  if (!externalRow) return null;
  const canRead = await canReadResource(ctx, "skill", externalRow.id, externalRow.organizationId);
  if (!canRead) return null;
  const [decorated] = await decorateResourceAccess(ctx, "skill", [externalRow], external.publicReadMap);
  return decorated;
}

export async function getSkillById(ctx: AuthContext, id: string): Promise<SkillConfigRowWithAccess | null> {
  const rows = await db.select().from(skill).where(eq(skill.id, id)).limit(1);
  const row = (rows[0] ?? null) as SkillConfigRow | null;
  if (!row) return null;

  if (row.organizationId === ctx.organizationId) {
    const [decorated] = await decorateResourceAccess(ctx, "skill", [row]);
    return decorated;
  }

  const canRead = await canReadResource(ctx, "skill", row.id, row.organizationId);
  if (!canRead) return null;
  const [decorated] = await decorateResourceAccess(ctx, "skill", [row]);
  return decorated;
}

export async function getSkillByResourceKey(
  ctx: AuthContext,
  resourceKey: string,
): Promise<SkillConfigRowWithAccess | null> {
  const parsed = parseResourceKey(resourceKey);
  if (!parsed) return null;

  const rows = await db.select().from(skill).where(eq(skill.id, parsed.resourceUid)).limit(1);
  const row = (rows[0] ?? null) as SkillConfigRow | null;
  if (!row || row.organizationId !== parsed.sourceOrganizationId) return null;

  const canRead = await canReadResource(ctx, "skill", row.id, row.organizationId);
  if (!canRead) return null;

  const [decorated] = await decorateResourceAccess(ctx, "skill", [row]);
  return decorated;
}

/**
 * 仅更新当前组织内部 Skill 的公开读取权限。
 *
 * 权限是资源授权数据，不属于 SKILL.md 内容；因此此函数不得经由 upsertSkill
 * 或任何文件系统写入路径，避免设置公开性时重写 Skill 文档。
 */
export async function setSkillPublicReadable(
  ctx: AuthContext,
  name: string,
  publicReadable: boolean,
): Promise<SkillConfigRowWithAccess | null> {
  const row = await getSkill(ctx, name);
  if (!row) return null;

  assertInternalWritable(ctx, "skill", row.id, row.organizationId);
  await setPublicRead(ctx, "skill", row.organizationId, row.id, publicReadable);

  return await getSkill(ctx, name);
}

export async function upsertSkill(
  ctx: AuthContext,
  name: string,
  data: SkillUpsertData,
  options: SkillSetOptions = {},
) {
  const existing = await db
    .select({ id: skill.id })
    .from(skill)
    .where(and(eq(skill.organizationId, ctx.organizationId), eq(skill.name, name)))
    .limit(1);

  const commonFields = {
    description: data.description,
    metadata: data.metadata ?? undefined,
    updatedAt: new Date(),
  };

  if (existing.length > 0) {
    assertInternalWritable(ctx, "skill", existing[0].id, ctx.organizationId);
    await db.update(skill).set(commonFields).where(eq(skill.id, existing[0].id));
    logger.info(
      `[SkillConfig] skill_write user=${ctx.userId} org=${ctx.organizationId} skill=${name} action=${options.auditAction ?? "set"} mode=update`,
    );
    if (options.publicReadable !== undefined) {
      await setPublicRead(ctx, "skill", ctx.organizationId, existing[0].id, options.publicReadable);
    }
    return existing[0].id;
  }

  const inserted = await db
    .insert(skill)
    .values({
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      name,
      ...commonFields,
    })
    .returning({ id: skill.id });
  logger.info(
    `[SkillConfig] skill_write user=${ctx.userId} org=${ctx.organizationId} skill=${name} action=${options.auditAction ?? "set"} mode=insert`,
  );
  if (options.publicReadable !== undefined) {
    await setPublicRead(ctx, "skill", ctx.organizationId, inserted[0].id, options.publicReadable);
  }
  return inserted[0].id;
}

export async function deleteSkill(ctx: AuthContext, name: string): Promise<boolean> {
  const row = await getSkill(ctx, name);
  if (!row) return false;

  assertInternalWritable(ctx, "skill", row.id, row.organizationId);
  const result = await db.delete(skill).where(eq(skill.id, row.id)).returning({ id: skill.id });
  if (result.length > 0) {
    logger.info(`[SkillConfig] skill_delete user=${ctx.userId} org=${ctx.organizationId} skill=${name}`);
  }
  return result.length > 0;
}

export async function deleteSkillById(ctx: AuthContext, id: string): Promise<boolean> {
  const row = await getSkillById(ctx, id);
  if (!row) return false;

  assertInternalWritable(ctx, "skill", row.id, row.organizationId);
  const result = await db.delete(skill).where(eq(skill.id, row.id)).returning({ id: skill.id });
  if (result.length > 0) {
    logger.info(`[SkillConfig] skill_delete user=${ctx.userId} org=${ctx.organizationId} skill=${row.name}`);
  }
  return result.length > 0;
}
