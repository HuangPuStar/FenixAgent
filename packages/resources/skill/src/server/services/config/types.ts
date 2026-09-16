import type { ResourceAccess } from "@fenix/access-control/server";

export type { ResourceAccess } from "@fenix/access-control/server";

/** Metadata persisted alongside a Skill document. */
export type SkillMetadata = Record<string, string>;

/** Data accepted when creating or updating a Skill. */
export interface SkillUpsertData {
  description?: string;
  metadata?: SkillMetadata;
}

/** Skill metadata accompanied by authorization information. */
export interface SkillConfigRowWithAccess {
  id: string;
  userId: string;
  organizationId: string;
  name: string;
  description: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  resourceAccess: ResourceAccess;
}

/** Optional behavior for a Skill write. */
export interface SkillSetOptions {
  publicReadable?: boolean;
  auditAction?: "set" | "upload_create" | "upload_overwrite";
}
