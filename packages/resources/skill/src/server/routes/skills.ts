import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import Elysia from "elysia";
import * as z from "zod/v4";
import { getSkillServerModule } from "../runtime";
import { getGlobalSkillsDir } from "../services/skill-content";
import { verifySkillDownloadToken } from "../services/skill-download-token";
import { assertValidSkillName, getSkillArchivePath } from "../services/skill-fs";

const SkillDownloadQuerySchema = z.object({
  token: z.string().min(1).describe("技能下载令牌。"),
});

const SkillDownloadParamsSchema = z.object({
  name: z.string().min(1).describe("要下载的技能名称。"),
});

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ success: false, error: { code, message } }, { status });
}

/**
 * 受令牌保护的 `/skills/:name/download`。
 *
 * 与其他两条路由不同，这条**不是工厂**：令牌本身就是授权凭据（无 session、无 actor），不需要宿主的
 * `sessionAuth` 宏，因此没有需要注入的守卫，也没有第二份实例可注入。它保留为模块级实例，按名导出，
 * 与工厂导出并列在 `src/server.ts`，宿主挂载点见 `apps/server/src/main.ts`。
 */
export const skillDownloadRoutes = new Elysia({ name: "skills", prefix: "/skills" }).model({
  "skill-download-params": SkillDownloadParamsSchema,
  "skill-download-query": SkillDownloadQuerySchema,
});

skillDownloadRoutes.get(
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

    // 令牌本身就是这条路径的授权凭据（无 session、无 actor），因此经系统路径按 ID 读取并复核三元组：
    // 令牌里的组织与名称必须与资源行一致，避免签名有效但指向已变更归属的资源。
    const record = await getSkillServerModule().system.findById({ resourceId: payload.skillId });
    if (!record || record.organizationId !== payload.organizationId || record.name !== name) {
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
        "供 plugin/runtime 使用的受令牌保护下载入口。根据路径参数中的技能名称和 query 中的下载令牌下载技能 zip 压缩包。该接口返回二进制文件流，而不是 JSON 响应。",
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
