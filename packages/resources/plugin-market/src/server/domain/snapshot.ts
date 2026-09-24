import type { NormalizedPackageVersion } from "../npm-registry/types";

/**
 * 已落库快照的解析。
 *
 * 写侧用它做落库前的最后一道校验，读侧用它把存储内容变成展示投影：**两处共用同一个解析器**，否则
 * 「写侧接受的形状」与「读侧能渲染的形状」会各自漂移，症状是一行合法写入的数据在列表页上抛错。
 *
 * 解析失败返回 null 而不是抛错：读侧的契约是「一行坏数据不能掀翻整个列表」，由调用方决定是跳过还是报错。
 * 校验只覆盖**渲染必需**的结构（字符串身份 + 四个数组）；可空标量缺失时由展示层回退为 null，因此这里
 * 不做全文校验——那会变成第二份 `normalize`，而两者的输入确实不同（一个是外部 JSON，一个是自有存储）。
 */
export function parsePackageSnapshot(metadataJson: string): NormalizedPackageVersion | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.name !== "string" || typeof candidate.version !== "string") return null;
  if (
    !Array.isArray(candidate.keywords) ||
    !Array.isArray(candidate.agents) ||
    !Array.isArray(candidate.skills) ||
    !Array.isArray(candidate.servers)
  ) {
    return null;
  }
  return parsed as NormalizedPackageVersion;
}
