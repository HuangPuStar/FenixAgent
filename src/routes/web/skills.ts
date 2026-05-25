import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import Elysia from "elysia";
import { db } from "../../db";
import { skill } from "../../db/schema";
import { getGlobalSkillsDir } from "../../services/skill";
import { verifySkillDownloadToken } from "../../services/skill-download-token";
import { assertValidSkillName, getSkillArchivePath } from "../../services/skill-fs";

const app = new Elysia({ name: "web-skills", prefix: "/skills" });

function jsonError(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status });
}

app.get("/:name/download", async ({ params, query, set }) => {
  let name: string;
  try {
    name = assertValidSkillName(params.name);
  } catch {
    return jsonError(400, "validation_error", "Invalid skill name");
  }

  const token = typeof query.token === "string" ? query.token : "";
  const payload = verifySkillDownloadToken(token);
  if (!payload || payload.skillName !== name) {
    return jsonError(403, "forbidden", "Invalid skill download token");
  }

  const rows = await db
    .select({ id: skill.id })
    .from(skill)
    .where(and(eq(skill.id, payload.skillId), eq(skill.organizationId, payload.organizationId), eq(skill.name, name)))
    .limit(1);
  if (rows.length === 0) {
    return jsonError(404, "not_found", "Skill not found");
  }

  const archivePath = getSkillArchivePath(getGlobalSkillsDir(), name);
  const info = await stat(archivePath).catch(() => null);
  if (!info?.isFile()) {
    return jsonError(404, "not_found", "Skill archive not found");
  }

  set.headers["Content-Type"] = "application/zip";
  set.headers["Content-Disposition"] = `attachment; filename="${name}.zip"`;
  return new Response(createReadStream(archivePath) as unknown as ReadableStream);
});

export default app;
