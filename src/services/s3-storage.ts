/**
 * S3 兼容对象存储服务 — 封装 AWS SDK v3，支持 RustFS / MinIO / AWS S3。
 *
 * 所有公开函数在 S3 未启用时抛出明确错误；客户端采用懒初始化，
 * 首次调用时才创建 S3Client，避免启动时依赖 S3 可用。
 */

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config";

// ── 懒初始化单例 ──────────────────────────────────────────────

let s3Client: S3Client | null = null;

function getClient(): S3Client {
  if (!config.s3.enabled) throw new Error("S3 storage is not enabled (RCS_S3_ENABLED=true)");
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      credentials: {
        accessKeyId: config.s3.accessKey,
        secretAccessKey: config.s3.secretKey,
      },
      forcePathStyle: true,
    });
  }
  return s3Client;
}

/** 预初始化客户端（可选，服务启动时调用） */
export function initS3(): void {
  if (config.s3.enabled) getClient();
}

// ── Key 安全校验 ─────────────────────────────────────────────

function normalizeKey(key: string): string {
  // 拒绝 null 字节
  if (key.includes("\0")) {
    throw new Error(`Invalid S3 key: null byte detected (${key})`);
  }
  // 去除前导/尾随空白、斜杠、./ 前缀
  const normalized = key
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/^\/+|\/+$/g, "");
  // 防止路径遍历（仅匹配作为路径段的 ..）
  if (/(?:^|\/)\.\.(?:\/|$)/.test(normalized)) {
    throw new Error(`Invalid S3 key: path traversal detected (${key})`);
  }
  return normalized;
}

// ── 服务端 CRUD ──────────────────────────────────────────────

/** 上传 Buffer 到 S3 */
export async function upload(bucket: string, key: string, body: Buffer, contentType?: string): Promise<void> {
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: normalizeKey(key),
      Body: body,
      ...(contentType ? { ContentType: contentType } : {}),
    }),
  );
}

/** 从 S3 下载对象，返回完整 Buffer */
export async function download(bucket: string, key: string): Promise<Buffer> {
  const client = getClient();
  const res = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: normalizeKey(key),
    }),
  );
  const bytes = await res.Body?.transformToByteArray();
  if (!bytes) throw new Error(`S3 object not found: ${key}`);
  return Buffer.from(bytes);
}

/** 删除单个对象 */
export async function remove(bucket: string, key: string): Promise<void> {
  const client = getClient();
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: normalizeKey(key),
    }),
  );
}

/** 删除前缀下所有对象（用于会话/目录清理） */
export async function removePrefix(bucket: string, prefix: string): Promise<void> {
  const client = getClient();
  const normalizedPrefix = normalizeKey(prefix);
  let continuationToken: string | undefined;

  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: normalizedPrefix.endsWith("/") ? normalizedPrefix : `${normalizedPrefix}/`,
        ContinuationToken: continuationToken,
      }),
    );
    const objects = res.Contents?.map((obj) => ({ Key: obj.Key! }));
    if (objects && objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects },
        }),
      );
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);
}

/** 列出前缀下的对象 */
export async function list(
  bucket: string,
  prefix: string,
): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
  const client = getClient();
  const normalizedPrefix = normalizeKey(prefix);
  const results: Array<{ key: string; size: number; lastModified: Date }> = [];
  let continuationToken: string | undefined;

  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: normalizedPrefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key && obj.Size != null && obj.LastModified) {
        results.push({ key: obj.Key, size: obj.Size, lastModified: obj.LastModified });
      }
    }
    continuationToken = res.NextContinuationToken;
  } while (continuationToken);

  return results;
}

/** 检查对象是否存在 */
export async function exists(bucket: string, key: string): Promise<boolean> {
  const client = getClient();
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: normalizeKey(key),
      }),
    );
    return true;
  } catch (err: unknown) {
    const s3Err = err as { $metadata?: { httpStatusCode?: number }; name?: string };
    if (s3Err?.$metadata?.httpStatusCode === 404 || s3Err?.name === "NotFound") return false;
    console.error("[S3] exists() error:", err);
    throw err;
  }
}

// ── Presigned URL ────────────────────────────────────────────

/** 生成 GET presigned URL（浏览器直连下载） */
export async function getPresignedGetUrl(bucket: string, key: string, expiresIn?: number): Promise<string> {
  const client = getClient();
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: normalizeKey(key),
    }),
    { expiresIn: expiresIn ?? config.s3.presignExpires },
  );
}

/** 生成 PUT presigned URL（浏览器直连上传） */
export async function getPresignedPutUrl(
  bucket: string,
  key: string,
  contentType: string,
  expiresIn?: number,
): Promise<string> {
  const client = getClient();
  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: normalizeKey(key),
      ContentType: contentType,
    }),
    { expiresIn: expiresIn ?? config.s3.presignUploadExpires },
  );
}

// ── 便捷函数（默认 bucket + key 前缀） ───────────────────────

function sessionKey(sessionId: string, relativePath: string): string {
  return normalizeKey(`sessions/${sessionId}/${relativePath}`);
}

function _assetKey(relativePath: string): string {
  return normalizeKey(`assets/${relativePath}`);
}

export async function uploadSessionFile(
  sessionId: string,
  relativePath: string,
  body: Buffer,
  contentType?: string,
): Promise<void> {
  return upload(config.s3.bucketSessions, sessionKey(sessionId, relativePath), body, contentType);
}

export async function downloadSessionFile(sessionId: string, relativePath: string): Promise<Buffer> {
  return download(config.s3.bucketSessions, sessionKey(sessionId, relativePath));
}

export async function deleteSessionFile(sessionId: string, relativePath: string): Promise<void> {
  return remove(config.s3.bucketSessions, sessionKey(sessionId, relativePath));
}

export async function listSessionFiles(
  sessionId: string,
  prefix?: string,
): Promise<Array<{ key: string; size: number; lastModified: Date }>> {
  return list(config.s3.bucketSessions, sessionKey(sessionId, prefix || ""));
}

export async function getSessionFileUrl(sessionId: string, relativePath: string): Promise<string> {
  return getPresignedGetUrl(config.s3.bucketSessions, sessionKey(sessionId, relativePath));
}

export async function getSessionUploadUrl(
  sessionId: string,
  relativePath: string,
  contentType: string,
): Promise<string> {
  return getPresignedPutUrl(config.s3.bucketSessions, sessionKey(sessionId, relativePath), contentType);
}

export async function removeSessionPrefix(sessionId: string): Promise<void> {
  return removePrefix(config.s3.bucketSessions, `sessions/${sessionId}`);
}

// ── Testing hook ─────────────────────────────────────────────

export function setS3ClientForTesting(client: S3Client | null): void {
  s3Client = client;
}
