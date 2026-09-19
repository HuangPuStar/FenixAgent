/**
 * 「可用模型」投影的按主体缓存。
 *
 * `/web/config/models` 会把当前主体可见的 Provider 及其模型摊平成一份可供模型选择器直接渲染的列表。
 * 构建它需要按 Provider 逐个取详情（N+1），因此按主体缓存 5 分钟；**`/web` 的 Provider / Model 写路径**
 * 主动失效（`/api/models` 与模型网关同步路径不自持失效，属迁移前既有行为——那条路径写入后最长一个
 * TTL 内仍是旧快照，由 TTL 与 `/web/config/models/refresh` 兜底）。
 *
 * 为什么单独一个模块：这是一份**跨路由共享的可变状态**。放在任一条路由文件里都会让另一条路由跨目录
 * 反向引用它，也会让"谁负责失效"变得不可见。缓存与失效入口在同一处，调用点一眼可查。
 *
 * 缓存键是 `(organizationId, userId)`，**必须是主体而不是组织**：被缓存的值是 `buildAvailableList`
 * 的产物，其中每一行都带 `scope` 与 `access`，而 `access.actions` 由 actor 在该组织里的角色推导
 * （owner/admin 拿到资源声明的全部动作，member 只有 `memberDefaultActions`）。只按组织分键会让同组织
 * 的另一个用户——包括角色不同的用户——直接读到前一个用户的授权投影。跨实例部署时各实例各自持有，
 * 最坏情况是多一次重建。缓存条目在 TTL 内可能被反复读取，写入时顺带清掉过期条目，避免键空间随
 * 活跃用户数无界增长。
 */

import type { ResourceRecord } from "@fenix/platform-sdk";

/** 模型选择器渲染一行所需的业务字段。 */
export interface AvailableModelFields {
  /** 模型行 ID（UUID）。 */
  readonly id: string;
  /** 模型业务键；用户偏好里保存的就是 `provider/modelId` 形式的引用。 */
  readonly modelId: string;
  readonly displayName: string;
  /** 所属 Provider 的配置名。 */
  readonly provider: string;
  /**
   * 所属 Provider 的资源 ID（UUID）。
   *
   * 前端据此拼 `${organizationId}/${providerId}/${modelId}` 形式的模型引用：跨组织 Provider 无法仅凭
   * 配置名定位（同名 Provider 可能存在于多个组织），资源键才是稳定标识。
   */
  readonly providerId: string;
  readonly providerDisplayName: string;
  readonly contextLimit: number | null;
  readonly outputLimit: number | null;
  readonly modalities?: unknown;
  /**
   * 来源组织名；**仅跨组织可见的 Provider** 才有值。
   *
   * 沿用迁移前 `resourceAccess.sourceOrganizationName` 的语义：本组织 Provider 不填，避免给每一行
   * 都加上当前组织名前缀。
   */
  readonly organizationName?: string;
}

/**
 * 可用模型列表的一行。
 *
 * `scope` / `access` 描述的是 **Provider**：模型没有自己的归属与动作集合，它的可访问性完全继承父
 * 资源（决策 D6）。因此这两项与 Provider 视图里的同名字段同形，前端可以用同一套判断函数处理两者。
 */
export type AvailableModelEntry = ResourceRecord<AvailableModelFields>;

/** 缓存 5 分钟；`/web/config/models/refresh` 可强制绕过。 */
export const AVAILABLE_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  readonly models: readonly AvailableModelEntry[];
  readonly updatedAt: number;
}

/**
 * 缓存主体：可用模型列表的授权投影由「哪个组织的哪个用户」共同决定。
 *
 * 两个字段都来自 identity 产出的不透明 ID（UUID），因此用 `:` 拼接不会产生键碰撞。
 */
export interface AvailableModelsSubject {
  readonly organizationId: string;
  readonly userId: string;
}

const cachedAvailableBySubject = new Map<string, CacheEntry>();

function cacheKeyOf(subject: AvailableModelsSubject): string {
  return `${subject.organizationId}:${subject.userId}`;
}

/** 读缓存；未命中或已过期返回 `undefined`，由调用方重建。`forceRefresh` 跳过读取但仍会写回。 */
export function readAvailableModelsCache(
  subject: AvailableModelsSubject,
  forceRefresh: boolean,
  now: number,
): readonly AvailableModelEntry[] | undefined {
  if (forceRefresh) return;
  const cached = cachedAvailableBySubject.get(cacheKeyOf(subject));
  if (!cached) return;
  if (now - cached.updatedAt >= AVAILABLE_MODELS_CACHE_TTL_MS) return;
  return cached.models;
}

/** 写回缓存；顺带回收已过期的条目，把键空间限制在 TTL 内的活跃主体上。 */
export function writeAvailableModelsCache(
  subject: AvailableModelsSubject,
  models: readonly AvailableModelEntry[],
  now: number,
): void {
  for (const [key, entry] of cachedAvailableBySubject) {
    if (now - entry.updatedAt >= AVAILABLE_MODELS_CACHE_TTL_MS) cachedAvailableBySubject.delete(key);
  }
  cachedAvailableBySubject.set(cacheKeyOf(subject), { models, updatedAt: now });
}

/** 失效单个主体的缓存；用户偏好变更时用它，避免影响同组织其他用户。 */
export function deleteAvailableModelsCache(subject: AvailableModelsSubject): void {
  cachedAvailableBySubject.delete(cacheKeyOf(subject));
}

/** 失效全部主体的缓存；Provider / Model 的写路径用它。 */
export function invalidateAvailableModelsCache(): void {
  cachedAvailableBySubject.clear();
}
