import type { AgentSiteAppRow, SiteAppVisibility } from "../repositories/agent-site-app";

/**
 * 站点**发布面**的读缓存：远端 app id → 发布范围与归属标识，60 秒 TTL。
 *
 * 发布面是访客链路（可能未登录），它对每个静态资源请求都要判定一次"这个访客是否落在站点的发布范围内"，
 * 命中缓存可以避免每次回库。缓存只保存可见性判定需要的三个标识，不保存 `platform_token` 等凭据。
 *
 * 失效责任在写路径：管理面改动发布范围后必须调 {@link invalidatePublishTarget}，否则旧范围最多继续
 * 生效 60 秒（`facades/agent-site-app-facade.ts` 在更新发布范围时调用）。
 */

/** 发布面定位结果：对外站点访问需要的最小投影。 */
export interface SitePublishTarget {
  readonly visibility: SiteAppVisibility;
  readonly organizationId: string;
  readonly userId: string;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { readonly target: SitePublishTarget; readonly at: number }>();

/** 使指定站点的发布范围缓存失效；改动发布范围后必须调用。 */
export function invalidatePublishTarget(remoteAppId: string): void {
  cache.delete(remoteAppId);
}

/**
 * 读取发布目标；命中缓存时不再回库。
 *
 * `load` 由调用方给出（站点 Facade 传领域服务的无授权定位），本模块因此不持有数据库访问，只负责
 * 缓存与投影。
 */
export async function loadPublishTarget(
  remoteAppId: string,
  load: () => Promise<AgentSiteAppRow | undefined>,
): Promise<SitePublishTarget | null> {
  const cached = cache.get(remoteAppId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.target;
  const row = await load();
  if (!row) return null;
  const target: SitePublishTarget = {
    visibility: row.visibility as SiteAppVisibility,
    organizationId: row.organizationId,
    userId: row.userId,
  };
  cache.set(remoteAppId, { target, at: Date.now() });
  return target;
}
