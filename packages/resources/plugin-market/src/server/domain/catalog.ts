import { PluginMarketError } from "../errors";
import { nextMonotonicInstant } from "./clock";
import { toPackageSlug } from "./slug";
import { parsePackageSnapshot } from "./snapshot";
import type {
  CatalogAuditEntry,
  CatalogDecision,
  CatalogPackage,
  CatalogPublication,
  CatalogState,
  CatalogWrite,
  PublicationChange,
  PublicationState,
  PublishCommand,
  UnpublishCommand,
} from "./types";

/**
 * 市场目录的**全部**写入规则，以纯函数形式表达。
 *
 * 为什么是纯函数而不是把规则写进仓储：本仓库的测试进程里没有 Postgres（`bun test` 不连库），把规则写在
 * SQL 里等于让最重要的一批规则（幂等、latest 回退、逻辑时钟、不变量）失去可执行断言。因此规则在这里决策，
 * 产出**写清单**（`CatalogWrite[]`），由仓储在同一个事务里执行——`noop` 的「严格无副作用」于是成为一条可
 * 断言的性质（清单为空），而不是口头约定。
 *
 * 规则逐条对应源项目 `open-mcp-market` 的 `catalog/service.ts`（移植时不得增删语义）：
 * 1. 聚合根 `(sourceId, packageName)` 唯一，exact version 只能发布一次；
 * 2. 快照发布后不可变：恢复只改 `publishedAt` / `unpublishedAt`，`firstPublishedAt` 不变；
 * 3. `publishedAt` 是逻辑时钟（见 `clock.ts`）；
 * 4. 下架 latest 时**先移指针再置水印**（本文件用一次性返回的写清单表达，顺序即数组顺序）；
 * 5. 幂等：决策基于事务内重新读取的状态，`noop` 零写入；
 * 6. 三条不变量由 `invariants.ts` 独立检查。
 */

/**
 * 版本排序键：`published_at DESC, id DESC`。
 *
 * 平局由 id 决定而不是保持到达顺序：逻辑时钟让服务自己写出的版本永不碰撞时刻，因此平局只可能来自库里的
 * 历史数据或并发写入；而「最新可见版本」必须在两次读之间是同一个人，否则 latest 回退会随机抖动。
 *
 * 比较用字符串字面序（`<`/`>`）而不是 `localeCompare`：存储层的 `ORDER BY id DESC` 走的是字节序，两侧
 * 必须是同一种序，否则内存里选出的 latest 与 SQL 里的一条会不一致。
 */
const byPublicationOrder = (left: CatalogPublication, right: CatalogPublication): number => {
  const delta = right.publishedAt.getTime() - left.publishedAt.getTime();
  if (delta !== 0) return delta;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
};

/**
 * 按对外顺序（`published_at DESC, id DESC`）排列任意版本集合。
 *
 * 导出它是为了让读侧的展示投影复用**同一个**排序，而不是各自写一份 `sort`：公开面的版本历史顺序与
 * latest 的判定必须是同一种序，否则列表首位与 latest 指针会在平局时指向不同版本。
 */
export function orderPublications(publications: readonly CatalogPublication[]): CatalogPublication[] {
  return [...publications].sort(byPublicationOrder);
}

/** 可见版本，按 `published_at DESC, id DESC`；即对外的版本历史顺序。 */
export function visiblePublications(state: CatalogState): CatalogPublication[] {
  return orderPublications(state.publications.filter((publication) => publication.unpublishedAt === null));
}

/** 全部版本（含已下架），按同一排序；管理台用。 */
export function allPublications(state: CatalogState): CatalogPublication[] {
  return orderPublications(state.publications);
}

/** 最新可见版本；没有可见版本时返回 null。 */
export function newestVisiblePublication(state: CatalogState): CatalogPublication | null {
  return visiblePublications(state)[0] ?? null;
}

/** 某个包已记录的最大发布时刻，喂给逻辑时钟。 */
export function maxPublishedAt(state: CatalogState): Date | null {
  return state.publications.reduce<Date | null>(
    (max, publication) => (max === null || publication.publishedAt > max ? publication.publishedAt : max),
    null,
  );
}

/** 除 `excludedId` 外的最新可见版本；latest 回退的候选。 */
function newestVisibleOtherThan(state: CatalogState, excludedId: string): CatalogPublication | null {
  return visiblePublications(state).find((publication) => publication.id !== excludedId) ?? null;
}

/**
 * 一个精确版本此刻相对市场的位置。
 *
 * 公开面**不区分「已下架」与「不存在」**（两者都是 404，见 `docs/arch` 的可见性说明），因此这个区分只用于
 * 写路径分派与授权后的管理视图。
 */
export function findPublicationState(state: CatalogState | null, exactVersion: string): PublicationState {
  const publication = state?.publications.find((entry) => entry.exactVersion === exactVersion) ?? null;
  if (!publication) return { state: "missing", publication: null };
  return { state: publication.unpublishedAt === null ? "visible" : "hidden", publication };
}

/** 由聚合状态组装 `PublicationChange`；三处决策共用，避免字段漂移。 */
function toChange(input: {
  action: PublicationChange["action"];
  state: CatalogState;
  publicationId: string;
  exactVersion: string;
  previousLatestPublicationId: string | null;
  latestPublicationId: string | null;
  affectedVersions: readonly string[];
}): PublicationChange {
  const { state } = input;
  return {
    action: input.action,
    packageId: state.package.id,
    packageName: state.package.packageName,
    packageSlug: toPackageSlug(state.package.packageName),
    publicationId: input.publicationId,
    exactVersion: input.exactVersion,
    previousLatestPublicationId: input.previousLatestPublicationId,
    latestPublicationId: input.latestPublicationId,
    affectedVersions: input.affectedVersions,
  };
}

/**
 * 把某个精确版本纳入市场（或确认它已在市场里）。
 *
 * 状态分派与源项目 §「publish 的状态分派」逐条一致：
 *
 * | 库内状态 | 动作 | 写清单 |
 * |---|---|---|
 * | 不存在 | `publish`：插入新快照并移动 latest | create? + insert + set-latest |
 * | 存在且已下架 | `restore`：复用首次快照，只前移逻辑时刻 | update + set-latest |
 * | 存在且可见 | `noop`：**不动 latest** | 空 |
 *
 * 最易写错的是最后一行：把「发布一个已可见的旧版本」实现成移动 latest 会直接破坏不变量 I3（latest 必须
 * 等于最新可见版本），而它在测试里只表现为「版本顺序变了」这种温和症状。
 */
export function planPublish(
  state: CatalogState | null,
  command: PublishCommand,
  now: Date,
): CatalogDecision<PublicationChange> {
  const snapshot = parsePackageSnapshot(command.metadataJson);
  if (!snapshot) {
    throw new PluginMarketError("METADATA_INVALID", "待发布的快照不是合法的市场快照 JSON");
  }

  if (!state) {
    // 新包：聚合根与首个版本在同一事务里落库（指针先为 NULL，写入版本后再回填，复合外键因此始终成立）。
    const packageId = crypto.randomUUID();
    const publicationId = crypto.randomUUID();
    const createdAt = now;
    const catalogPackage: CatalogPackage = {
      id: packageId,
      sourceId: command.sourceId,
      packageName: command.packageName,
      organizationId: command.creationScope.organizationId,
      ownerUserId: command.creationScope.ownerUserId,
      latestPublicationId: null,
      createdAt,
      updatedAt: createdAt,
    };
    const publication: CatalogPublication = {
      id: publicationId,
      packageId,
      exactVersion: command.exactVersion,
      metadataJson: command.metadataJson,
      metadataDigest: command.metadataDigest,
      firstPublishedAt: createdAt,
      publishedAt: createdAt,
      unpublishedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    const created: CatalogState = {
      package: { ...catalogPackage, latestPublicationId: publicationId },
      publications: [publication],
    };
    return {
      result: toChange({
        action: "publish",
        state: created,
        publicationId,
        exactVersion: command.exactVersion,
        previousLatestPublicationId: null,
        latestPublicationId: publicationId,
        affectedVersions: [command.exactVersion],
      }),
      writes: [
        { kind: "create-package", package: catalogPackage },
        { kind: "insert-publication", publication },
        { kind: "set-latest", packageId, latestPublicationId: publicationId, updatedAt: createdAt },
      ],
      audit: auditEntry("publish", created, publicationId, command.operatorUserId, command.requestId, createdAt),
    };
  }

  const previousLatest = state.package.latestPublicationId;
  const existing = state.publications.find((entry) => entry.exactVersion === command.exactVersion) ?? null;

  if (existing && existing.unpublishedAt === null) {
    // 严格幂等：不刷新快照、不动时间戳、不移动 latest、不写审计。
    return {
      result: toChange({
        action: "noop",
        state,
        publicationId: existing.id,
        exactVersion: existing.exactVersion,
        previousLatestPublicationId: previousLatest,
        latestPublicationId: previousLatest,
        affectedVersions: [],
      }),
      writes: [],
      audit: null,
    };
  }

  // 时刻在包已存在之后分配，才能与该包已记录的每一个时刻比较（见 `clock.ts`）。
  const publishedAt = nextMonotonicInstant(now, maxPublishedAt(state));

  if (existing) {
    // 恢复：首次快照与 `firstPublishedAt` 保持权威且不可变，只把逻辑时刻前移越过当前最新版本。
    const restored: CatalogPublication = { ...existing, publishedAt, unpublishedAt: null, updatedAt: publishedAt };
    const nextState: CatalogState = {
      package: { ...state.package, latestPublicationId: restored.id, updatedAt: publishedAt },
      publications: state.publications.map((entry) => (entry.id === restored.id ? restored : entry)),
    };
    return {
      result: toChange({
        action: "restore",
        state: nextState,
        publicationId: restored.id,
        exactVersion: restored.exactVersion,
        previousLatestPublicationId: previousLatest,
        latestPublicationId: restored.id,
        affectedVersions: [restored.exactVersion],
      }),
      writes: [
        { kind: "update-publication", publication: restored },
        { kind: "set-latest", packageId: state.package.id, latestPublicationId: restored.id, updatedAt: publishedAt },
      ],
      audit: auditEntry("restore", nextState, restored.id, command.operatorUserId, command.requestId, publishedAt),
    };
  }

  const publicationId = crypto.randomUUID();
  const publication: CatalogPublication = {
    id: publicationId,
    packageId: state.package.id,
    exactVersion: command.exactVersion,
    metadataJson: command.metadataJson,
    metadataDigest: command.metadataDigest,
    firstPublishedAt: publishedAt,
    publishedAt,
    unpublishedAt: null,
    createdAt: publishedAt,
    updatedAt: publishedAt,
  };
  const nextState: CatalogState = {
    package: { ...state.package, latestPublicationId: publicationId, updatedAt: publishedAt },
    publications: [...state.publications, publication],
  };
  return {
    result: toChange({
      action: "publish",
      state: nextState,
      publicationId,
      exactVersion: command.exactVersion,
      previousLatestPublicationId: previousLatest,
      latestPublicationId: publicationId,
      affectedVersions: [command.exactVersion],
    }),
    writes: [
      { kind: "insert-publication", publication },
      { kind: "set-latest", packageId: state.package.id, latestPublicationId: publicationId, updatedAt: publishedAt },
    ],
    audit: auditEntry("publish", nextState, publicationId, command.operatorUserId, command.requestId, publishedAt),
  };
}

/**
 * 下架一个精确版本。
 *
 * 若被下架的正是 latest，**必须先移指针再置水印**：写清单里的 `set-latest` 排在 `update-publication` 之前，
 * 仓储按序执行，因此任何中间时刻都不存在「latest 指向一个已隐藏版本」的状态。这也是源项目用触发器强制的
 * 那条规则的等价物——本仓库由顺序保证（见 `db/schema.ts` 的不变量承载说明）。
 */
export function planUnpublish(
  state: CatalogState | null,
  command: UnpublishCommand,
  now: Date,
): CatalogDecision<PublicationChange> {
  const target = state?.publications.find((entry) => entry.exactVersion === command.exactVersion) ?? null;
  if (!state || !target) {
    throw new PluginMarketError("PUBLICATION_NOT_FOUND", "该版本不在市场中，无法下架");
  }

  const previousLatest = state.package.latestPublicationId;
  if (target.unpublishedAt !== null) {
    return {
      result: toChange({
        action: "noop",
        state,
        publicationId: target.id,
        exactVersion: target.exactVersion,
        previousLatestPublicationId: previousLatest,
        latestPublicationId: previousLatest,
        affectedVersions: [],
      }),
      writes: [],
      audit: null,
    };
  }

  const isLatest = previousLatest === target.id;
  const fallback = isLatest ? newestVisibleOtherThan(state, target.id) : null;
  const nextLatest = isLatest ? (fallback?.id ?? null) : previousLatest;
  const hidden: CatalogPublication = { ...target, unpublishedAt: now, updatedAt: now };
  const nextState: CatalogState = {
    package: { ...state.package, latestPublicationId: nextLatest, updatedAt: now },
    publications: state.publications.map((entry) => (entry.id === hidden.id ? hidden : entry)),
  };
  const writes: CatalogWrite[] = [];
  if (isLatest) {
    writes.push({ kind: "set-latest", packageId: state.package.id, latestPublicationId: nextLatest, updatedAt: now });
  }
  writes.push({ kind: "update-publication", publication: hidden });

  return {
    result: toChange({
      action: "unpublish",
      state: nextState,
      publicationId: hidden.id,
      exactVersion: hidden.exactVersion,
      previousLatestPublicationId: previousLatest,
      latestPublicationId: nextLatest,
      affectedVersions: [hidden.exactVersion],
    }),
    writes,
    audit: auditEntry("unpublish", nextState, hidden.id, command.operatorUserId, command.requestId, now),
  };
}

/** 组装审计条目；只有真实发生的动作才会走到这里（`noop` 在各自的分支里直接返回 null）。 */
function auditEntry(
  action: CatalogAuditEntry["action"],
  state: CatalogState,
  publicationId: string,
  operatorUserId: string,
  requestId: string | null,
  occurredAt: Date,
): CatalogAuditEntry {
  return {
    id: crypto.randomUUID(),
    action,
    packageId: state.package.id,
    publicationId,
    operatorUserId,
    occurredAt,
    requestId,
  };
}
