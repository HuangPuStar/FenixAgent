/**
 * 插件市场 catalog 领域的类型契约。
 *
 * 术语沿用源项目 `open-mcp-market`（改名会让两侧无法对照，故不改）：
 * - **包（聚合根）**：一个 NPM package 的市场身份，稳定键 `(sourceId, packageName)`。
 * - **版本（publication）**：某个 exact version 的一次纳入记录；快照**发布后不可变**。
 * - **latest**：包上的指针，指向当前对外的「最新可见版本」；NULL 表示该包所有版本都已下架。
 *
 * 这里是**领域模型**，不是协议 DTO、不是数据库行、也不是前端 ViewModel：三者的转换发生在各自边界
 * （协议层在 `schemas/`，存储层在 `repositories/`）。时间一律用 `Date`（`timestamptz` 的 JS 表示），
 * 不用字符串——字符串比较只在源项目里因为 SQLite 才成立。
 */

/** 聚合根的存储投影。 */
export interface CatalogPackage {
  readonly id: string;
  readonly sourceId: string;
  readonly packageName: string;
  /** 授权归属组织；市场条目统一归属系统托管租户，由 Facade 在创建期解析注入。 */
  readonly organizationId: string;
  readonly ownerUserId: string;
  readonly latestPublicationId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 一个版本的不可变快照 + 可见性水印。 */
export interface CatalogPublication {
  readonly id: string;
  readonly packageId: string;
  readonly exactVersion: string;
  /** 白名单快照的 JSON 文本；`metadataDigest` 是它的 SHA-256。 */
  readonly metadataJson: string;
  readonly metadataDigest: string;
  /** 首次纳入市场的时刻；恢复时**不变**。 */
  readonly firstPublishedAt: Date;
  /** 逻辑时钟；恢复时前移到新的单调时刻。 */
  readonly publishedAt: Date;
  /** 下架水印；NULL 表示可见。 */
  readonly unpublishedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * 一个包的**完整**聚合状态：聚合根 + 它的全部版本行。
 *
 * 全部规则（latest 回退、可见性、逻辑时钟）都只需要包内数据，因此按聚合一次读完再决策，而不是逐条查询
 * 边读边判：这样规则可以是纯函数，而测试不需要数据库（本仓库的测试进程里没有 Postgres）。
 */
export interface CatalogState {
  readonly package: CatalogPackage;
  readonly publications: readonly CatalogPublication[];
}

/** 真实发生的领域动作。`noop` 不是动作，而是「请求已被满足」。 */
export type CatalogAction = "publish" | "restore" | "unpublish";

/**
 * 一次写操作的领域结果。
 *
 * `previousLatestPublicationId` 与 `latestPublicationId` 同时给出，是为了让调用方能判断「latest 是否移动」
 * 而不必自己再读一次库；`affectedVersions` 列出内容可能变化的版本，供缓存失效使用。
 */
export interface PublicationChange {
  readonly action: CatalogAction | "noop";
  readonly packageId: string;
  readonly packageName: string;
  readonly packageSlug: string;
  readonly publicationId: string;
  readonly exactVersion: string;
  readonly previousLatestPublicationId: string | null;
  readonly latestPublicationId: string | null;
  readonly affectedVersions: readonly string[];
}

/**
 * 创建包时的归属信息。
 *
 * 聚合**不做授权判断**（那是 Facade 的职责），但归属列是行的一部分，因此创建命令必须携带它。三列由
 * Facade 经 `resolveInitialScope` 解析：组织固定为系统托管租户，`ownerUserId` 为操作人。
 */
export interface CatalogCreationScope {
  readonly organizationId: string;
  readonly ownerUserId: string;
}

/** 发布一个精确版本所需的全部输入。 */
export interface PublishCommand {
  readonly sourceId: string;
  readonly packageName: string;
  readonly exactVersion: string;
  readonly metadataJson: string;
  readonly metadataDigest: string;
  /** 创建期归属；包已存在时忽略。 */
  readonly creationScope: CatalogCreationScope;
  /** 审计流水里的操作人。 */
  readonly operatorUserId: string;
  readonly requestId: string | null;
}

/** 下架一个精确版本所需的全部输入。 */
export interface UnpublishCommand {
  readonly sourceId: string;
  readonly packageName: string;
  readonly exactVersion: string;
  readonly operatorUserId: string;
  readonly requestId: string | null;
}

/**
 * 需要落库的变更。
 *
 * 领域决策把「要写什么」表达成这张清单而不是直接调 SQL：这样 `noop` 的「严格无副作用」是一条**可断言**
 * 的性质（清单为空），而不是一句约定。
 */
export type CatalogWrite =
  | { readonly kind: "create-package"; readonly package: CatalogPackage }
  | { readonly kind: "insert-publication"; readonly publication: CatalogPublication }
  | { readonly kind: "update-publication"; readonly publication: CatalogPublication }
  | {
      readonly kind: "set-latest";
      readonly packageId: string;
      readonly latestPublicationId: string | null;
      readonly updatedAt: Date;
    };

/** 只追加的审计条目。 */
export interface CatalogAuditEntry {
  readonly id: string;
  readonly action: CatalogAction;
  readonly packageId: string;
  readonly publicationId: string;
  readonly operatorUserId: string;
  readonly occurredAt: Date;
  readonly requestId: string | null;
}

/**
 * 领域决策：结果 + 要写的行 + 审计。
 *
 * 三者一起返回的理由是它们必须**同时**成立：返回值里的 `latestPublicationId` 与清单里的 `set-latest` 若
 * 由两处分别推导，就会出现「响应说移了指针、实际没移」这类无法从任一侧发现的偏差。
 */
export interface CatalogDecision<T> {
  readonly result: T;
  readonly writes: readonly CatalogWrite[];
  readonly audit: CatalogAuditEntry | null;
}

/** 一个精确版本此刻相对市场的位置；供发布路径分派使用。 */
export interface PublicationState {
  readonly state: "missing" | "visible" | "hidden";
  readonly publication: CatalogPublication | null;
}
