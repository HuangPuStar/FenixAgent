import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import Elysia from "elysia";
import * as z from "zod/v4";
import { db } from "../../db";
import { skill } from "../../db/schema";
import { getGlobalSkillsDir } from "../../services/skill";
import { verifySkillDownloadToken } from "../../services/skill-download-token";
import { assertValidSkillName, getSkillArchivePath } from "../../services/skill-fs";

const SkillDownloadQuerySchema = z.object({
  token: z.string().min(1).describe("技能下载令牌。"),
});

const SkillDownloadParamsSchema = z.object({
  name: z.string().min(1).describe("要下载的技能名称。"),
});

const app = new Elysia({ name: "web-skills", prefix: "/skills" }).model({
  "skill-download-params": SkillDownloadParamsSchema,
  "skill-download-query": SkillDownloadQuerySchema,
});

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ success: false, error: { code, message } }, { status });
}

app.get(
  "/:name/download",
  // biome-ignore lint/suspicious/noExplicitAny: 下载接口返回二进制流，Elysia 在 query + 非 JSON 响应场景下类型推断不稳定
  async ({ params, query, set }: any) => {
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

    const archivePath = getSkillArchivePath(getGlobalSkillsDir(), payload.organizationId, name);
    const info = await stat(archivePath).catch(() => null);
    if (!info?.isFile()) {
      return jsonError(404, "not_found", "Skill archive not found");
    }

    set.headers["Content-Type"] = "application/zip";
    set.headers["Content-Disposition"] = `attachment; filename="${name}.zip"`;
    return new Response(createReadStream(archivePath) as unknown as ReadableStream);
  },
  {
    params: "skill-download-params",
    query: "skill-download-query",
    detail: {
      hide: true,
      tags: ["Skills"],
      summary: "下载技能压缩包",
      description:
        "根据路径参数中的技能名称和 query 中的下载令牌下载技能 zip 压缩包。该接口返回二进制文件流，而不是 JSON 响应。",
      parameters: [
        {
          name: "token",
          in: "query",
          required: true,
          description: "技能下载令牌。",
          schema: {
            type: "string",
          },
        },
      ],
    },
  },
);

export default app;
