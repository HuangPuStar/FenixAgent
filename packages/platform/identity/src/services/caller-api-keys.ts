/**
 * 调用方自身的 API Key 编排。
 *
 * 所有操作都以请求方 `headers` 为凭据交给 better-auth 的 apiKey 插件鉴权：调用方只能读写自己
 * 名下的 key，身份侧不额外推断归属。这里的价值是把 better-auth 未类型化的返回形状收敛成稳定
 * 契约，并集中"页面创建的 key 必须继承当前组织与角色"这条不变量——后续纯 API Key 调用要靠它
 * 从 apikey 记录恢复组织上下文（CLAUDE.md「认证、组织与密钥」）。
 */

import { getAuth } from "../auth/better-auth";

/** better-auth apiKey 插件的窄化视图：正式类型未导出，这里只声明实际使用的四个方法。 */
interface CallerApiKeyApi {
  listApiKeys: (opts: { headers: Headers }) => Promise<unknown>;
  createApiKey: (opts: {
    body: { name: string; prefix: string; expiresIn: number | null; metadata: unknown };
    headers: Headers;
  }) => Promise<unknown>;
  deleteApiKey: (opts: { body: { keyId: string }; headers: Headers }) => Promise<void>;
  updateApiKey: (opts: { body: { id: string; name?: string }; headers: Headers }) => Promise<void>;
}

function callerApiKeyApi(): CallerApiKeyApi {
  return getAuth().api as unknown as CallerApiKeyApi;
}

/**
 * 列表中一把 key 的最小识别信息。
 *
 * better-auth 的列表项还带 `id` / `start` / `expiresAt` 等字段；它们随版本变化，路由层用
 * `normalizeApiKeyDateValues` 原样透传，本契约只固定编排逻辑真正依赖的 `id` 与 `name`。
 */
export interface CallerApiKeySummary {
  readonly id: string;
  readonly name: string;
  readonly [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * 抽取 better-auth 返回的 key 列表。
 *
 * 插件在版本之间存在两种形状：直接返回数组，或包在 `{ apiKeys }` 里；两者都必须支持，否则
 * 重名检查会静默失效并累积同名 key。
 */
export function extractCallerApiKeys(result: unknown): CallerApiKeySummary[] {
  const list = Array.isArray(result) ? result : asRecord(result)?.apiKeys;
  if (!Array.isArray(list)) return [];
  const keys: CallerApiKeySummary[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (!record || typeof record.id !== "string") continue;
    keys.push({ ...record, id: record.id, name: normalizeApiKeyName(record.name) });
  }
  return keys;
}

/** 规范化 key 名称：空字符串与空白名称视为未命名。 */
export function normalizeApiKeyName(name: unknown): string {
  return typeof name === "string" ? name.trim() : "";
}

/** 把 better-auth 返回值里的 `Date` 递归转成 ISO 字符串，避免 OpenAPI 序列化阶段丢字段。 */
export function normalizeApiKeyDateValues(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeApiKeyDateValues);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, normalizeApiKeyDateValues(nested)]),
    );
  }
  return value;
}

/**
 * 构造 API Key metadata。
 *
 * 页面创建的 key 必须继承当前组织与角色，才能在后续纯 API Key 的 HTTP 调用里从 apikey 记录
 * 恢复出一致的组织上下文；调用方传入的 metadata 只能作为附加字段，不得覆盖这两个键。
 */
export function buildApiKeyMetadata(
  metadata: unknown,
  authContext: { organizationId: string; role: string },
): Record<string, unknown> {
  const base = asRecord(metadata) ?? {};
  return {
    ...base,
    organizationId: authContext.organizationId,
    role: authContext.role,
  };
}

/** 读取调用方名下的 API Key 列表（不含明文 key）。 */
export async function listCallerApiKeys(headers: Headers): Promise<CallerApiKeySummary[]> {
  return extractCallerApiKeys(await callerApiKeyApi().listApiKeys({ headers }));
}

/** 调用方 key 的创建入参。 */
export interface CreateCallerApiKeyInput {
  readonly headers: Headers;
  readonly name: string;
  /** key 前缀；页面固定为 `rcs_`。 */
  readonly prefix: string;
  /** 过期秒数；`null` 表示不过期。 */
  readonly expiresIn: number | null;
  readonly metadata: unknown;
}

/** 创建调用方 API Key，返回 better-auth 的完整结果（含明文 key，仅此一次可见）。 */
export async function createCallerApiKey(input: CreateCallerApiKeyInput): Promise<unknown> {
  return callerApiKeyApi().createApiKey({
    body: {
      name: input.name,
      prefix: input.prefix,
      expiresIn: input.expiresIn,
      metadata: input.metadata,
    },
    headers: input.headers,
  });
}

/** 删除调用方名下的 API Key。 */
export async function deleteCallerApiKey(input: { headers: Headers; keyId: string }): Promise<void> {
  await callerApiKeyApi().deleteApiKey({ body: { keyId: input.keyId }, headers: input.headers });
}

/** 更新调用方名下的 API Key 名称。 */
export async function updateCallerApiKey(input: { headers: Headers; id: string; name?: string }): Promise<void> {
  await callerApiKeyApi().updateApiKey({ body: { id: input.id, name: input.name }, headers: input.headers });
}
