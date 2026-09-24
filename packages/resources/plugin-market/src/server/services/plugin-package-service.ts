import type { ResourceQueryConstraint } from "@fenix/platform-sdk";
import { pluginMarketPackage } from "@fenix/resource-plugin-market/db";
import { eq, isNotNull, type SQL } from "drizzle-orm";
import {
  comparePackageViewsForCatalog,
  type PackageDetailView,
  type PackageView,
  pickDisplayPublication,
  toPackageDetailView,
  toPackageView,
} from "../domain/package-view";
import { fromPackageSlug } from "../domain/slug";
import { toCatalogPackage, toCatalogPublication } from "../repositories/plugin-package";
import type { PluginPackageReadRepository } from "../repositories/plugin-package-read";

/**
 * 市场目录的读侧领域服务。
 *
 * 只做两件事：把「读口径」翻译成业务条件交给仓储下推，把行投影成视图（`domain/package-view.ts`）。不接收
 * actor、不做任何权限判断——授权条件是不透明的 `access` 句柄，由 Facade 产出后原样下推。
 *
 * 它是 `route → Facade → Domain Service → Repository` 里唯一允许拼业务条件的一层：条件里出现的是包名、
 * 来源与可见性口径这些**业务列**，不出现组织、角色或 `visibility`（后者属于资源主表的授权列，只由平台
 * 的谓词编译器读取）。
 */

/**
 * 读口径：这是个**授权结论的输入**，不是查询参数。
 *
 * `public` = 公开面（非写权主体）：整包下架的条目与「不存在」同响应——列表里根本没有它、详情里查不到它。
 * `all` = 管理面（写权主体）：含整包下架的条目，版本历史带下架水印。两者共用同一条 `latest_publication_id
 * IS NOT NULL` 谓词，因此「列表里有、详情却 404」这类不一致不可能出现。
 *
 * 口径由 Facade 按授权结果给出（见 `facades/plugin-package-facade.ts` 的 `resolveReadScope`），服务不做
 * 任何再判断：在这里重算一次权限，就等于有了第二处授权实现。
 */
export type CatalogReadScope = "public" | "all";

export interface PluginPackageService {
  list(input: {
    readonly access: ResourceQueryConstraint;
    readonly sourceId: string;
    readonly scope: CatalogReadScope;
  }): Promise<{ items: PackageView[]; total: number }>;
  /** 按 slug 定位详情；不存在、slug 非法或按当前口径不可见时都返回 `undefined`（由 Facade 统一映射为 404）。 */
  findDetailBySlug(input: {
    readonly access: ResourceQueryConstraint;
    readonly sourceId: string;
    readonly scope: CatalogReadScope;
    readonly slug: string;
  }): Promise<PackageDetailView | undefined>;
}

export function createPluginPackageService(repository: PluginPackageReadRepository): PluginPackageService {
  /**
   * 读口径 → 业务条件。
   *
   * 包级可见性**必须**在这里（也就是下推到 SQL），不能在应用层过滤：总数与列表项来自同一次查询的两个
   * 部分，只在内存里滤掉几条会让 `total` 大于实际条数，前端的分页与「共 N 个」都会对不上。
   *
   * 按 `source_id` 过滤是 slug 定位符成立的前提：本期的 slug 只编码包名（决策 D4，单一来源），若同一包名
   * 在多个来源下各有一条聚合根，slug 就无法区分它们——列表里会出现两条同 slug 的条目、详情只能随机命中
   * 一条。列表与详情用**同一个**来源条件，可见集合因此一致；换掉 `PLUGIN_MARKET_SOURCE_ID` 等于换一个
   * 目录，旧来源的行不再展示。支持第二来源时，这条条件必须改成「把 sourceId 编进 slug」。
   */
  function catalogConditions(input: {
    readonly sourceId: string;
    readonly scope: CatalogReadScope;
    readonly packageName?: string;
  }): SQL[] {
    const conditions: SQL[] = [eq(pluginMarketPackage.sourceId, input.sourceId)];
    if (input.packageName !== undefined) {
      conditions.push(eq(pluginMarketPackage.packageName, input.packageName));
    }
    if (input.scope === "public") {
      conditions.push(isNotNull(pluginMarketPackage.latestPublicationId));
    }
    return conditions;
  }

  /** 版本行按包分组；列表一次读回全部包的版本，避免 N+1。 */
  function groupByPackage<T extends { packageId: string }>(rows: readonly T[]): Map<string, T[]> {
    const grouped = new Map<string, T[]>();
    for (const row of rows) {
      const bucket = grouped.get(row.packageId);
      if (bucket) bucket.push(row);
      else grouped.set(row.packageId, [row]);
    }
    return grouped;
  }

  return {
    async list(input) {
      const page = await repository.listReadable({
        access: input.access,
        businessWhere: catalogConditions(input),
      });

      const publications = await repository.listPublications({
        packageIds: page.items.map((row) => row.id),
      });
      const grouped = groupByPackage(publications);

      const items = page.items.map((row) => {
        const catalogPackage = toCatalogPackage(row);
        const entries = (grouped.get(row.id) ?? []).map((publication) => toCatalogPublication(publication));
        return toPackageView({
          package: catalogPackage,
          scope: row.scope,
          display: pickDisplayPublication(catalogPackage, entries),
        });
      });
      // 排序在应用层完成（理由见 `comparePackageViewsForCatalog`）：列表是全量返回，没有「先分页再排序」的
      // 错误空间；一旦引入服务端分页，这条排序必须随之下推到 SQL。
      items.sort(comparePackageViewsForCatalog);
      return { items, total: page.total };
    },

    async findDetailBySlug(input) {
      const packageName = fromPackageSlug(input.slug);
      // slug 只接受规范编码（`domain/slug.ts`）：非法编码不是「另一个包名」，它连包名都还原不出来。
      if (packageName === null) return;

      const row = await repository.findReadable({
        access: input.access,
        businessWhere: catalogConditions({ ...input, packageName }),
      });
      if (!row) return;

      const catalogPackage = toCatalogPackage(row);
      const publications = await repository.listPublications({ packageIds: [row.id] });
      return toPackageDetailView({
        package: catalogPackage,
        scope: row.scope,
        publications: publications.map((publication) => toCatalogPublication(publication)),
        includeHidden: input.scope === "all",
      });
    },
  };
}
