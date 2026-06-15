import Elysia from "elysia";
import { config } from "../../config";
import { authGuardPlugin } from "../../plugins/auth";
import { environmentRepo, sessionRepo } from "../../repositories";
import type { S3DeleteBody, S3PresignPutBody } from "../../schemas/s3-file.schema";
import {
  S3DeleteBodySchema,
  S3DeleteResponseSchema,
  S3FileListQuerySchema,
  S3FileListResponseSchema,
  S3PresignGetQuerySchema,
  S3PresignGetResponseSchema,
  S3PresignPutBodySchema,
  S3PresignPutResponseSchema,
  S3UploadQuerySchema,
  S3UploadResponseSchema,
} from "../../schemas/s3-file.schema";
import * as s3 from "../../services/s3-storage";

const app = new Elysia({ name: "web-s3-files", prefix: "/s3" })
  .use(authGuardPlugin)
  .onBeforeHandle(({ error }) => {
    if (!config.s3.enabled) {
      return error(503, { error: { type: "service_unavailable", message: "S3 storage is not enabled" } });
    }
  })
  .model({
    "s3-delete-body": S3DeleteBodySchema,
    "s3-delete-response": S3DeleteResponseSchema,
    "s3-file-list-query": S3FileListQuerySchema,
    "s3-file-list-response": S3FileListResponseSchema,
    "s3-presign-get-query": S3PresignGetQuerySchema,
    "s3-presign-get-response": S3PresignGetResponseSchema,
    "s3-presign-put-body": S3PresignPutBodySchema,
    "s3-presign-put-response": S3PresignPutResponseSchema,
    "s3-upload-query": S3UploadQuerySchema,
    "s3-upload-response": S3UploadResponseSchema,
  });

/** 验证 sessionId 所属环境属于指定组织 */
async function requireSessionInOrg(
  sessionId: string,
  orgId: string,
  error: (code: number, body: unknown) => Response,
): Promise<Response | null> {
  const session = await sessionRepo.getById(sessionId);
  if (!session) return error(404, { error: { type: "not_found", message: "Session not found" } });
  if (!session.environmentId)
    return error(400, { error: { type: "validation_error", message: "Session has no environment" } });
  const env = await environmentRepo.getById(session.environmentId);
  if (!env) return error(404, { error: { type: "not_found", message: "Environment not found" } });
  if (env.organizationId !== orgId)
    return error(403, { error: { type: "forbidden", message: "Session does not belong to your organization" } });
  return null;
}

// 列出会话文件
app.get(
  "/files",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 query/response 组合下类型推断不稳定
  async ({ query, error, store }: any) => {
    const orgId = store.authContext?.organizationId;
    if (!orgId) return error(403, { error: { type: "forbidden", message: "No organization context" } });

    const q = query as Record<string, string | undefined>;
    const sessionId = q.sessionId;
    const prefix = q.prefix || "";
    if (!sessionId) return error(400, { error: { type: "validation_error", message: "sessionId is required" } });

    const denied = await requireSessionInOrg(sessionId, orgId, error);
    if (denied) return denied;

    const objects = await s3.listSessionFiles(sessionId, prefix);
    const sessionPrefix = `sessions/${sessionId}/`;
    const offset = sessionPrefix.length + (prefix ? prefix.length + 1 : 0);
    const entries = objects.map((obj) => ({
      key: obj.key,
      name: obj.key.slice(offset),
      size: obj.size,
      lastModified: obj.lastModified.getTime(),
    }));

    return { entries, prefix };
  },
  {
    sessionAuth: true,
    query: "s3-file-list-query",
    response: "s3-file-list-response",
    detail: {
      tags: ["Files"],
      summary: "【S3】获取 S3 文件列表",
      description: "列出指定会话在 S3 中保存的文件，可通过 prefix 过滤子目录。",
    },
  },
);

// 获取下载 presigned URL
app.get(
  "/files/presign",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 query/response 组合下类型推断不稳定
  async ({ query, error, store }: any) => {
    const orgId = store.authContext?.organizationId;
    if (!orgId) return error(403, { error: { type: "forbidden", message: "No organization context" } });

    const q = query as Record<string, string | undefined>;
    const sessionId = q.sessionId;
    const key = q.key;
    if (!sessionId || !key)
      return error(400, { error: { type: "validation_error", message: "sessionId and key are required" } });

    const denied = await requireSessionInOrg(sessionId, orgId, error);
    if (denied) return denied;

    const url = await s3.getSessionFileUrl(sessionId, key);
    const expiresAt = Date.now() + config.s3.presignExpires * 1000;
    return { url, key, expiresAt };
  },
  {
    sessionAuth: true,
    query: "s3-presign-get-query",
    response: "s3-presign-get-response",
    detail: {
      tags: ["Files"],
      summary: "【S3】获取 S3 下载地址",
      description: "为指定会话文件生成一个临时可用的 S3 下载链接。",
    },
  },
);

// 获取上传 presigned URL
app.post(
  "/files/presign",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 body/response 组合下类型推断不稳定
  async ({ body, error, store }: any) => {
    const orgId = store.authContext?.organizationId;
    if (!orgId) return error(403, { error: { type: "forbidden", message: "No organization context" } });

    const b = body as S3PresignPutBody;
    if (!b.sessionId || !b.key || !b.contentType) {
      return error(400, {
        error: { type: "validation_error", message: "sessionId, key and contentType are required" },
      });
    }

    const denied = await requireSessionInOrg(b.sessionId, orgId, error);
    if (denied) return denied;

    const url = await s3.getSessionUploadUrl(b.sessionId, b.key, b.contentType);
    const expiresAt = Date.now() + config.s3.presignUploadExpires * 1000;
    return { url, key: b.key, expiresAt };
  },
  {
    sessionAuth: true,
    body: "s3-presign-put-body",
    response: "s3-presign-put-response",
    detail: {
      tags: ["Files"],
      summary: "【S3】获取 S3 上传地址",
      description: "为指定会话文件生成一个临时可用的 S3 上传链接。",
    },
  },
);

// 服务端中转上传（fallback，用于浏览器无法直连 S3 的场景）
app.post(
  "/files/upload",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 query/response 组合下类型推断不稳定
  async ({ query, request, error, store }: any) => {
    const orgId = store.authContext?.organizationId;
    if (!orgId) return error(403, { error: { type: "forbidden", message: "No organization context" } });

    const q = query as Record<string, string | undefined>;
    const sessionId = q.sessionId;
    if (!sessionId)
      return error(400, { error: { type: "validation_error", message: "sessionId query param is required" } });

    const denied = await requireSessionInOrg(sessionId, orgId, error);
    if (denied) return denied;

    const formData = await request.formData();
    const files = formData.getAll("files") as File[];
    if (!files || files.length === 0) {
      return error(400, { error: { type: "validation_error", message: "No files provided" } });
    }

    const uploaded: Array<{ key: string; name: string; size: number }> = [];
    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      await s3.uploadSessionFile(sessionId, file.name, buffer, file.type || undefined);
      uploaded.push({
        key: `sessions/${sessionId}/${file.name}`,
        name: file.name,
        size: buffer.length,
      });
    }
    return { files: uploaded };
  },
  {
    sessionAuth: true,
    query: "s3-upload-query",
    response: "s3-upload-response",
    detail: {
      tags: ["Files"],
      summary: "【S3】上传文件到 S3",
      description: "通过服务端中转将文件上传到指定会话的 S3 存储空间，适用于浏览器无法直连 S3 的场景。",
    },
  },
);

// 删除文件
app.delete(
  "/files",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 body/response 组合下类型推断不稳定
  async ({ body, error, store }: any) => {
    const orgId = store.authContext?.organizationId;
    if (!orgId) return error(403, { error: { type: "forbidden", message: "No organization context" } });

    const b = body as S3DeleteBody;
    if (!b.sessionId || !b.key) {
      return error(400, { error: { type: "validation_error", message: "sessionId and key are required" } });
    }

    const denied = await requireSessionInOrg(b.sessionId, orgId, error);
    if (denied) return denied;

    await s3.deleteSessionFile(b.sessionId, b.key);
    return { ok: true as const };
  },
  {
    sessionAuth: true,
    body: "s3-delete-body",
    response: "s3-delete-response",
    detail: {
      tags: ["Files"],
      summary: "【S3】删除 S3 文件",
      description: "删除指定会话在 S3 中保存的单个文件。",
    },
  },
);

export default app;
