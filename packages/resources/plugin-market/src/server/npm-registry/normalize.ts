import { PluginMarketError } from "../errors";
import type { NormalizedPackageVersion, SnapshotAgent, SnapshotServer, SnapshotSkill } from "./types";

/**
 * npm 私有源输入的安全边界。
 *
 * 外部 registry 是**不可信输入**，同时又是一条外部依赖，所以本文件承载三类判定：接受什么、拒绝什么、
 * 以及永远不做什么（请求 tarball）。所有上界集中在这里，是为了让边界可审计、可整体测试。
 *
 * **超限一律拒绝，绝不截断**：截断会让「管理员预览到的内容」与「实际落库的内容」不一致，而预览-确认
 * 流程的全部意义就是「落库的正是预览过的那一份」（比对凭据是 `metadataDigest`）。
 */

/** 全部上界。单位：长度按字符（JS string length），字节数由调用方单独设定。 */
export const LIMITS = {
  maxJsonDepth: 12,
  maxNameLength: 214,
  maxDescriptionLength: 2048,
  maxSummaryLength: 512,
  maxDisplayNameLength: 120,
  maxKeywords: 32,
  maxKeywordLength: 64,
  maxAgents: 32,
  maxAgentIdLength: 64,
  maxAgentNameLength: 120,
  maxAgentDescriptionLength: 512,
  maxSkills: 64,
  maxSkillUriLength: 512,
  maxSkillNameLength: 128,
  maxSkillDescriptionLength: 512,
  maxServers: 32,
  maxServerIdLength: 64,
  maxTransportLength: 32,
  maxRuntimeLength: 64,
  maxDeprecatedLength: 512,
  maxIntegrityLength: 256,
  maxUrlLength: 2048,
} as const;

/** npm 包名长度上限（沿用 npm 自身口径：214 字符）。 */
export const MAX_PACKAGE_NAME_LENGTH = LIMITS.maxNameLength;

const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** 严格精确 SemVer。范围、tag、部分版本一律拒绝——「一个版本」在这里必须是不可歧义的。 */
const EXACT_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const isPackageName = (value: string): boolean =>
  value.length > 0 && value.length <= MAX_PACKAGE_NAME_LENGTH && PACKAGE_NAME_PATTERN.test(value);

export const isExactVersion = (value: string): boolean =>
  value.length > 0 && value.length <= 128 && EXACT_VERSION_PATTERN.test(value);

/**
 * 包名形状校验。
 *
 * **必须在拼 URL 之前调用**：这是拼请求路径与落库前唯一的形状校验，`encodeURIComponent` 只负责转义、
 * 不构成校验（`../../admin` 编码后仍是合法路径段）。先例见源项目 `service.ts` 的请求路径构造。
 */
export const assertPackageName = (value: unknown): string => {
  if (typeof value !== "string" || !isPackageName(value))
    throw new PluginMarketError("INVALID_INPUT", "包名不合法：需要合法的 npm 包名（可含 scope，全小写）");
  return value;
};

/** 精确版本形状校验；理由同 {@link assertPackageName}。 */
export const assertExactVersion = (value: unknown): string => {
  if (typeof value !== "string" || !isExactVersion(value))
    throw new PluginMarketError("INVALID_INPUT", "版本号不合法：需要精确 SemVer（如 1.4.0），不接受范围或 tag");
  return value;
};

/**
 * 迭代式深度探测，**从不递归**。
 *
 * 敌意输入可以用极深嵌套打爆调用栈——那会变成 500，而正确结果是「超限拒绝」。用显式栈就没有这个问题，
 * 且深度判定在读字段之前完成，恶意结构不会被任何取值逻辑触碰。
 */
export function exceedsDepth(value: unknown, maxDepth: number): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const { node, depth } = frame;
    if (depth > maxDepth) return true;
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth: depth + 1 });
    } else if (typeof node === "object" && node !== null) {
      for (const item of Object.values(node as Record<string, unknown>)) stack.push({ node: item, depth: depth + 1 });
    }
  }
  return false;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN[ A-Z]*-----/,
  /\bauthorization\b\s*[:=]\s*\S{8,}/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/i,
  /data:[a-z0-9.+-]*\/[a-z0-9.+-]*;base64,/i,
  /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*\S{16,}/i,
  /[A-Za-z0-9+/]{64,}={0,2}/,
];

/**
 * 拒绝「看起来含凭据或内联二进制」的外部文本。
 *
 * 命中即**拒绝**而不是脱敏：脱敏后的快照与管理员预览到的不一致，会让 `metadataDigest` 这条比对凭据失去
 * 意义——而它正是「落库内容 = 预览内容」的唯一保证。
 */
export const looksLikeSecret = (value: string): boolean => SECRET_PATTERNS.some((pattern) => pattern.test(value));

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const requireString = (value: unknown, maxLength: number, field: string): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new PluginMarketError("METADATA_INVALID", `${field} 非法：需要非空字符串`);
  if (value.length > maxLength) throw new PluginMarketError("METADATA_TOO_LARGE", `${field} 超长`);
  if (looksLikeSecret(value)) throw new PluginMarketError("METADATA_INVALID", `${field} 疑似包含凭据`);
  return value;
};

const optionalString = (value: unknown, maxLength: number, field: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new PluginMarketError("METADATA_INVALID", `${field} 非法：需要字符串`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return requireString(trimmed, maxLength, field);
};

const optionalUrl = (value: unknown, field: string): string | null => {
  const text = optionalString(value, LIMITS.maxUrlLength, field);
  if (text === null) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new PluginMarketError("METADATA_INVALID", `${field} 非法：不是合法 URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new PluginMarketError("METADATA_INVALID", `${field} 必须是 http 或 https`);
  return parsed.toString();
};

/**
 * Subresource Integrity：一个或多个空格分隔的 `<algo>-<base64>` 摘要
 * （真实 npm 包是 `sha512-<88 个 base64 字符>`）。
 *
 * SRI 本身就是 base64，因此**不能**过 `looksLikeSecret`——它那条「≥64 个连续 base64 字符」的内联二进制
 * 启发式会误杀每一个真实发布过的包。这里改用形状校验，仍然保证该字段不能成为任意文本的载体。
 */
const INTEGRITY_PATTERN =
  /^[a-z0-9]+-[A-Za-z0-9+/]+={0,2}(?:\?[A-Za-z0-9-]+)?(?:\s+[a-z0-9]+-[A-Za-z0-9+/]+={0,2}(?:\?[A-Za-z0-9-]+)?)*$/;

const optionalIntegrity = (value: unknown, field: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new PluginMarketError("METADATA_INVALID", `${field} 非法：需要字符串`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > LIMITS.maxIntegrityLength) throw new PluginMarketError("METADATA_TOO_LARGE", `${field} 超长`);
  if (!INTEGRITY_PATTERN.test(trimmed)) throw new PluginMarketError("METADATA_INVALID", `${field} 不是合法摘要`);
  return trimmed;
};

/** 只接受非负安全整数；其余（含小数、负数、NaN、字符串数字）一律归一为 null。 */
const optionalNonNegativeInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

const normalizeKeywords = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [];
  if (value.length > LIMITS.maxKeywords) throw new PluginMarketError("METADATA_TOO_LARGE", "keywords 超长");
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const keyword = entry.trim();
    if (keyword.length === 0) continue;
    if (keyword.length > LIMITS.maxKeywordLength) throw new PluginMarketError("METADATA_TOO_LARGE", "keyword 超长");
    if (looksLikeSecret(keyword)) throw new PluginMarketError("METADATA_INVALID", "keyword 疑似包含凭据");
    seen.add(keyword);
  }
  return [...seen];
};

const SKILL_URI_PATTERN = /^skill:\/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+\/SKILL\.md$/;

const normalizeSkills = (value: unknown): SnapshotSkill[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PluginMarketError("METADATA_INVALID", "mcpp.skills 必须是数组");
  if (value.length > LIMITS.maxSkills) throw new PluginMarketError("METADATA_TOO_LARGE", "mcpp skills 超长");
  const seen = new Set<string>();
  const skills: SnapshotSkill[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) throw new PluginMarketError("METADATA_INVALID", "mcpp.skills 项必须是对象");
    const uri = requireString(record.uri, LIMITS.maxSkillUriLength, "mcpp.skills[].uri");
    if (!SKILL_URI_PATTERN.test(uri))
      throw new PluginMarketError("METADATA_INVALID", "mcpp.skills[].uri 非法：需要 skill://<路径>/SKILL.md");
    if (seen.has(uri)) throw new PluginMarketError("METADATA_INVALID", "mcpp.skills[].uri 重复");
    seen.add(uri);
    skills.push({
      uri,
      name: requireString(record.name, LIMITS.maxSkillNameLength, "mcpp.skills[].name"),
      description: optionalString(record.description, LIMITS.maxSkillDescriptionLength, "mcpp.skills[].description"),
    });
  }
  return skills;
};

const normalizeAgents = (value: unknown): SnapshotAgent[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PluginMarketError("METADATA_INVALID", "mcpp.agents 必须是数组");
  if (value.length > LIMITS.maxAgents) throw new PluginMarketError("METADATA_TOO_LARGE", "mcpp agents 超长");
  const seen = new Set<string>();
  const agents: SnapshotAgent[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) throw new PluginMarketError("METADATA_INVALID", "mcpp.agents 项必须是对象");
    const agentId = requireString(record.id, LIMITS.maxAgentIdLength, "mcpp.agents[].id");
    if (seen.has(agentId)) throw new PluginMarketError("METADATA_INVALID", "mcpp.agents[].id 重复");
    seen.add(agentId);
    agents.push({
      id: agentId,
      name: requireString(record.name, LIMITS.maxAgentNameLength, "mcpp.agents[].name"),
      description: optionalString(record.description, LIMITS.maxAgentDescriptionLength, "mcpp.agents[].description"),
    });
  }
  return agents;
};

const normalizeServers = (value: unknown): SnapshotServer[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PluginMarketError("METADATA_INVALID", "mcpp.servers 必须是数组");
  if (value.length > LIMITS.maxServers) throw new PluginMarketError("METADATA_TOO_LARGE", "mcpp servers 超长");
  const seen = new Set<string>();
  const servers: SnapshotServer[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) throw new PluginMarketError("METADATA_INVALID", "mcpp.servers 项必须是对象");
    const serverId = requireString(record.id, LIMITS.maxServerIdLength, "mcpp.servers[].id");
    if (seen.has(serverId)) throw new PluginMarketError("METADATA_INVALID", "mcpp.servers[].id 重复");
    seen.add(serverId);
    servers.push({
      id: serverId,
      transport: requireString(record.transport, LIMITS.maxTransportLength, "mcpp.servers[].transport"),
      runtime: optionalString(record.runtime, LIMITS.maxRuntimeLength, "mcpp.servers[].runtime"),
    });
  }
  return servers;
};

/** 本模块认识的 `package.json#mcpp.schemaVersion`。未知版本拒绝而不是尽力解析。 */
export const SUPPORTED_MCPP_SCHEMA_VERSION = 1;

/**
 * 从 packument 里读出精确版本，并**只拷贝白名单字段**到新对象。
 *
 * 未知扩展字段一律丢弃，这是「原始 packument 永不进存储」这条规则的落地点：即便某个包在版本条目里塞
 * 了 `scripts.postinstall`、`_npmUser` 或内联 base64，它们也不会随快照离开本函数。
 *
 * `mcpp` 块**缺失是合法的**（普通连接器包）；存在时 `schemaVersion` 必须是 1。
 */
export function normalizePackageVersion(
  packument: unknown,
  ref: { packageName: string; exactVersion: string },
): NormalizedPackageVersion {
  const packumentRecord = asRecord(packument);
  if (!packumentRecord) throw new PluginMarketError("METADATA_INVALID", "响应不是对象");
  if (exceedsDepth(packumentRecord, LIMITS.maxJsonDepth))
    throw new PluginMarketError("METADATA_TOO_LARGE", "元数据嵌套层级超限");

  const versions = asRecord(packumentRecord.versions);
  if (!versions) throw new PluginMarketError("METADATA_INVALID", "元数据缺少 versions");

  const versionEntry = asRecord(versions[ref.exactVersion]);
  if (!versionEntry) throw new PluginMarketError("VERSION_NOT_FOUND", "该包不含此版本");

  const name = requireString(versionEntry.name, LIMITS.maxNameLength, "name");
  const version = requireString(versionEntry.version, 128, "version");
  // 名字/版本必须与请求**完全一致**：私有源可能（因镜像、代理或恶意配置）回一个别的包，静默接受会把
  // 另一个包的内容挂到本包的身份下。
  if (name !== ref.packageName || version !== ref.exactVersion)
    throw new PluginMarketError("METADATA_INVALID", "响应的包名/版本与请求不一致");

  const mcpp = asRecord(versionEntry.mcpp);
  let displayName: string | null = null;
  let summary: string | null = null;
  let agents: SnapshotAgent[] = [];
  let skills: SnapshotSkill[] = [];
  let servers: SnapshotServer[] = [];
  if (mcpp) {
    if (mcpp.schemaVersion !== SUPPORTED_MCPP_SCHEMA_VERSION)
      throw new PluginMarketError("UNSUPPORTED_SCHEMA_VERSION", "不支持的 mcpp.schemaVersion", {
        supported: SUPPORTED_MCPP_SCHEMA_VERSION,
      });
    displayName = optionalString(mcpp.displayName, LIMITS.maxDisplayNameLength, "mcpp.displayName");
    summary = optionalString(mcpp.summary, LIMITS.maxSummaryLength, "mcpp.summary");
    agents = normalizeAgents(mcpp.agents);
    skills = normalizeSkills(mcpp.skills);
    servers = normalizeServers(mcpp.servers);
  }

  const dist = asRecord(versionEntry.dist);
  return {
    name,
    version,
    description: optionalString(versionEntry.description, LIMITS.maxDescriptionLength, "description"),
    keywords: normalizeKeywords(versionEntry.keywords),
    displayName,
    summary,
    agents,
    skills,
    servers,
    integrity: dist ? optionalIntegrity(dist.integrity, "dist.integrity") : null,
    tarballUrl: dist ? optionalUrl(dist.tarball, "dist.tarball") : null,
    unpackedSizeBytes: dist ? optionalNonNegativeInt(dist.unpackedSize) : null,
    fileCount: dist ? optionalNonNegativeInt(dist.fileCount) : null,
    deprecated: optionalString(versionEntry.deprecated, LIMITS.maxDeprecatedLength, "deprecated"),
    publishedAt: null,
  };
}

/** 快照的落库字节原文。落库与摘要都基于本函数的返回值，保证「存储内容 ≡ 存储摘要」。 */
export const serializeSnapshot = (metadata: NormalizedPackageVersion): string => JSON.stringify(metadata);

/** 快照摘要（`sha256:<hex>`），预览-确认流程的比对凭据。 */
export async function digestSnapshot(metadataJson: string): Promise<string> {
  const bytes = new TextEncoder().encode(metadataJson);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
