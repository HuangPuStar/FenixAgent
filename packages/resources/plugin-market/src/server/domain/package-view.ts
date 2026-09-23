import type { ResourceScope } from "@fenix/platform-sdk";
import type { NormalizedPackageVersion } from "../npm-registry/types";
import { orderPublications } from "./catalog";
import { toPackageSlug } from "./slug";
import { parsePackageSnapshot } from "./snapshot";
import type { CatalogPackage, CatalogPublication } from "./types";

/**
 * 市场条目的展示投影：读侧唯一的「聚合行 → 视图」转换。
 *
 * 为什么它属于领域而不是路由：这里承载两条**领域规则**，它们与协议无关——
 *
 * 1. **版本级可见性**：`unpublishedAt` 非空的版本对非写权主体与「不存在」同响应（源项目公开面的口径），
 *    因此版本历史对非写权主体只含可见版本，对写权主体则含全部版本并带下架水印。
 * 2. **整包下架时的展示回退**：包级可见性由 `latestPublicationId IS NULL` 表达，此时 `latestVersion`
 *    为 null，展示字段回退到最新版本（含已下架）的快照——否则管理台上一个刚下架的空包只剩一个 slug。
 *
 * 写成纯函数（入参是行，出参是视图）之后，这两条规则都能脱离数据库断言；写进路由则会在列表、详情与将来
 * 的 `/api` 入口各写一遍，且只有连着 Postgres 才能验证。
 *
 * 视图里**没有** `isExpertTeam` 这类派生标记：它是 `metadata.agents.length > 0` 的同义改写，服务端再算一遍
 * 只会多一个可能与前端不一致的字段。同理不携带 `organizationId` 之外的归属信息——市场条目单一归属，
 * 展示层不需要组织名。
 */

/** 版本历史项：只含展示与处置需要的字段，不含快照正文（详情页只渲染当前展示版本的正文）。 */
export interface PackageVersionView {
  readonly exactVersion: string;
  readonly metadataDigest: string;
  /** 首次纳入市场的时刻；恢复不会改变它。 */
  readonly firstPublishedAt: Date;
  /** 逻辑时钟时刻；恢复会前移。 */
  readonly publishedAt: Date;
  /** 下架水印；非写权主体的版本历史里不会出现非空值（那些版本整体不在可见集合里）。 */
  readonly unpublishedAt: Date | null;
  /** 是否指向聚合根的 latest 指针。整包下架的条目全为 false。 */
  readonly isLatest: boolean;
}

/** 市场条目的展示投影。 */
export interface PackageView {
  /** 受控资源 ID；授权动作与后续写路径都以它定位。 */
  readonly id: string;
  /** URL 安全定位符（包名的 base64url 编码）；列表与详情路由的路径段。 */
  readonly slug: string;
  readonly sourceId: string;
  readonly packageName: string;
  /** 当前对外的「最新可见版本」；整包下架时为 null（只有写权主体能看到这种条目）。 */
  readonly latestVersion: string | null;
  readonly latestPublicationId: string | null;
  /** 展示快照；快照正文坏损（非本模块写入）时为 null，由展示层回退到包名。 */
  readonly metadata: NormalizedPackageVersion | null;
  /** 展示快照的发布时刻；无版本时为 null。 */
  readonly publishedAt: Date | null;
  /** 是否整包下架。对非写权主体恒为 false：这类条目根本不在它的可见集合里。 */
  readonly hidden: boolean;
  readonly scope: ResourceScope;
}

/** 详情投影：在列表投影之上补版本历史。 */
export interface PackageDetailView extends PackageView {
  readonly versions: readonly PackageVersionView[];
}

/**
 * 选出用于展示的版本。
 *
 * 规则与源项目管理台一致：`latest` 存在就用它，否则回退到**最新版本**（此时该版本必然已下架，因为
 * 「有可见版本必有 latest」是不变量 I1）。回退取的是全部版本里的最新一条，不是「最新可见版本」——整包下架
 * 时后者为空，页面会退化成只有包名。
 */
export function pickDisplayPublication(
  catalogPackage: CatalogPackage,
  publications: readonly CatalogPublication[],
): CatalogPublication | null {
  const ordered = orderPublications(publications);
  if (catalogPackage.latestPublicationId === null) return ordered[0] ?? null;
  return ordered.find((publication) => publication.id === catalogPackage.latestPublicationId) ?? ordered[0] ?? null;
}

/** 把快照 JSON 解析成展示投影；坏数据返回 null 而不是抛错（一行坏数据不能掀翻整个列表）。 */
function toMetadata(publication: CatalogPublication | null): NormalizedPackageVersion | null {
  return publication === null ? null : parsePackageSnapshot(publication.metadataJson);
}

/** 组装列表/详情共用的字段。 */
export function toPackageView(input: {
  readonly package: CatalogPackage;
  readonly scope: ResourceScope;
  readonly display: CatalogPublication | null;
}): PackageView {
  const { package: catalogPackage, scope, display } = input;
  return {
    id: catalogPackage.id,
    slug: toPackageSlug(catalogPackage.packageName),
    sourceId: catalogPackage.sourceId,
    packageName: catalogPackage.packageName,
    // latest 指针存在 ⇒ 展示快照就是它指向的那一行（`pickDisplayPublication` 优先按 id 命中）。
    // 只有坏数据（指针悬空）才会出现「指针在、展示快照不是它」：此时宁可按「没有可展示的 latest」处理，
    // 也不要报出一个指针并不指向的版本号。
    latestVersion: display !== null && display.id === catalogPackage.latestPublicationId ? display.exactVersion : null,
    latestPublicationId: catalogPackage.latestPublicationId,
    metadata: toMetadata(display),
    publishedAt: display?.publishedAt ?? null,
    hidden: catalogPackage.latestPublicationId === null,
    scope,
  };
}

/**
 * 详情投影。
 *
 * `includeHidden` 由调用方（Facade）按授权结果给出，本函数不做任何权限判断：它只回答「给定这个口径，
 * 视图长什么样」。
 */
export function toPackageDetailView(input: {
  readonly package: CatalogPackage;
  readonly scope: ResourceScope;
  readonly publications: readonly CatalogPublication[];
  readonly includeHidden: boolean;
}): PackageDetailView {
  const { package: catalogPackage, scope, publications, includeHidden } = input;
  const ordered = orderPublications(publications);
  const visible = ordered.filter((publication) => publication.unpublishedAt === null);
  return {
    ...toPackageView({ package: catalogPackage, scope, display: pickDisplayPublication(catalogPackage, ordered) }),
    versions: (includeHidden ? ordered : visible).map((publication) => ({
      exactVersion: publication.exactVersion,
      metadataDigest: publication.metadataDigest,
      firstPublishedAt: publication.firstPublishedAt,
      publishedAt: publication.publishedAt,
      unpublishedAt: publication.unpublishedAt,
      isLatest: publication.id === catalogPackage.latestPublicationId,
    })),
  };
}

/**
 * 「最近发布」排序：展示快照的 `publishedAt DESC`，平局按 `latest` 指向的版本 id DESC（与公开面的版本序
 * 同一口径），整包下架的条目（无指针）之间再按包名升序——保证顺序在两次请求之间是确定的。
 *
 * 为什么在应用层排而不是交给 SQL：排序键是**展示快照**（latest 指向的版本；整包下架时是最新版本）的
 * `published_at`，它在另一张表上，用关联子查询表达只能靠手写 SQL。而市场列表是**全量返回**（决策 D7，
 * 前端过滤），没有「先分页再排序」的错误空间。将来若引入服务端分页，这条排序必须随之下推到 SQL。
 */
export function comparePackageViewsForCatalog(left: PackageView, right: PackageView): number {
  const delta = (right.publishedAt?.getTime() ?? 0) - (left.publishedAt?.getTime() ?? 0);
  if (delta !== 0) return delta;
  const leftId = left.latestPublicationId ?? "";
  const rightId = right.latestPublicationId ?? "";
  if (leftId === rightId) return left.packageName < right.packageName ? -1 : 1;
  return leftId < rightId ? 1 : -1;
}
