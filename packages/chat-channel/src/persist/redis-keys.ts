// Redis Cluster 安全键：同一 RCS session 的快照、generation fence 与 Pub/Sub
// 必须共享受控 hash tag；原始外部 ID 不得进入 `{...}` 控制位置。

const REDIS_KEY_PREFIX = "yjs:";
const REDIS_CHANNEL_PREFIX = "yjs:channel:";
const ACTIVE_GENERATION_PREFIX = "yjs:active-generation:";

export interface RedisSessionKeys {
  activeGenerationKey: string;
  legacyActiveGenerationKey: string | null;
  hashTag: string;
}

export interface RedisProviderKeys extends RedisSessionKeys {
  snapshotKey: string;
  legacySnapshotKey: string | null;
  channel: string;
}

function encodeRedisKeySegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * 为同一 RCS session 构造受控 Redis Cluster hash tag。原始 ID 只参与 UTF-8
 * base64url 编码，不能注入 `{...}` 或改变槽位选择。
 */
export function buildRedisSessionKeys(rcsSessionId: string): RedisSessionKeys {
  const hashTag = `{rcs-${encodeRedisKeySegment(rcsSessionId)}}`;
  return {
    activeGenerationKey: `${ACTIVE_GENERATION_PREFIX}${hashTag}`,
    legacyActiveGenerationKey:
      rcsSessionId.includes("{") || rcsSessionId.includes("}") ? null : `${ACTIVE_GENERATION_PREFIX}${rcsSessionId}`,
    hashTag,
  };
}

/** 构造 snapshot、generation fence 与 Pub/Sub 共槽的新键，并保留只读迁移用旧快照键。 */
export function buildRedisProviderKeys(docName: string, generation?: string): RedisProviderKeys {
  const separator = docName.indexOf(":");
  if (separator <= 0 || separator === docName.length - 1) {
    throw new Error("Redis Yjs docName must include a document type and RCS session ID");
  }
  const documentType = docName.slice(0, separator);
  if (documentType !== "chat" && documentType !== "session") {
    throw new Error("Redis Yjs document type must be chat or session");
  }

  const rcsSessionId = docName.slice(separator + 1);
  const sessionKeys = buildRedisSessionKeys(rcsSessionId);
  const generationSuffix = generation ? `:${encodeRedisKeySegment(generation)}` : "";
  const legacyGenerationSuffix = generation ? `:${generation}` : "";
  return {
    ...sessionKeys,
    snapshotKey: `${REDIS_KEY_PREFIX}${sessionKeys.hashTag}:${documentType}${generationSuffix}`,
    legacySnapshotKey:
      rcsSessionId.includes("{") || rcsSessionId.includes("}")
        ? null
        : `${REDIS_KEY_PREFIX}${docName}${legacyGenerationSuffix}`,
    channel: `${REDIS_CHANNEL_PREFIX}${sessionKeys.hashTag}:${documentType}${generationSuffix}`,
  };
}
