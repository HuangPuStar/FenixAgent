export type KnowledgeBaseParseMethod = "builtin" | "pipeline";

export interface KnowledgeBaseMetadataShape {
  embeddingModel: string | null;
  parseMethod: KnowledgeBaseParseMethod | null;
  chunkMethod: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeParseMethod(value: unknown): KnowledgeBaseParseMethod | null {
  return value === "builtin" || value === "pipeline" ? value : null;
}

/** 从数据库 metadata 中提取知识库配置。 */
export function readKnowledgeBaseMetadata(metadata: unknown): KnowledgeBaseMetadataShape {
  const raw = isRecord(metadata) ? metadata : {};
  return {
    embeddingModel: normalizeOptionalString(raw.embeddingModel),
    parseMethod: normalizeParseMethod(raw.parseMethod),
    chunkMethod: normalizeOptionalString(raw.chunkMethod),
  };
}

/**
 * 合并并规范化知识库 metadata。
 * 仅维护知识库配置相关字段，其他未知键保持原样，便于后续平滑扩展。
 */
export function mergeKnowledgeBaseMetadata(
  current: unknown,
  patch: {
    embeddingModel?: unknown;
    parseMethod?: unknown;
    chunkMethod?: unknown;
  },
): Record<string, unknown> | null {
  const next = isRecord(current) ? { ...current } : {};

  if ("embeddingModel" in patch) {
    const value = normalizeOptionalString(patch.embeddingModel);
    if (value) next.embeddingModel = value;
    else delete next.embeddingModel;
  }

  if ("parseMethod" in patch) {
    const value = normalizeParseMethod(patch.parseMethod);
    if (value) next.parseMethod = value;
    else delete next.parseMethod;
  }

  if ("chunkMethod" in patch) {
    const value = normalizeOptionalString(patch.chunkMethod);
    if (value) next.chunkMethod = value;
    else delete next.chunkMethod;
  }

  return Object.keys(next).length > 0 ? next : null;
}
