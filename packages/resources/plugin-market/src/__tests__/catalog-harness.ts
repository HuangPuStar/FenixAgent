import { planPublish, planUnpublish, visiblePublications } from "../server/domain/catalog";
import type {
  CatalogAuditEntry,
  CatalogPackage,
  CatalogPublication,
  CatalogState,
  CatalogWrite,
  PublicationChange,
  PublishCommand,
  UnpublishCommand,
} from "../server/domain/types";
import type { PluginCatalogPort } from "../server/facades/plugin-package-facade";
import { type CatalogStorePort, runCatalogTurn } from "../server/services/plugin-catalog-service";

/**
 * 目录规则的**内存底座**。
 *
 * 存在的理由：本仓库的测试进程里没有 Postgres，而目录最要紧的那批规则（幂等、latest 回退、逻辑时钟、
 * 恢复不改快照）必须能被逐条断言，不能只靠「读代码看出来是对的」。因此这里提供一个内存实现，让
 * **生产的**规则函数与 **生产的**事务时序（{@link runCatalogTurn}）原样跑起来。
 *
 * 它刻意只实现两件生产侧由 SQL 承担的事：
 * 1. **把写清单作用到内存状态**——对应仓储的 `applyCatalogWrites`（四个写种类的语义必须一致，生产侧的映射
 *    由 `plugin-catalog-store.test.ts` 单独钉住）；
 * 2. **把同一包的写操作串行化**——对应 `withPackageLock` 的事务级咨询锁。没有它，「并发发布同一版本」在
 *    内存里会退化成「八个调用者都读到空状态、各自插入」，测出的是一个生产上不存在的场景。
 *
 * 它**不**实现 SQL 约束（唯一索引、复合外键、CHECK）：那是存储层的事，内存底座重复一遍只会让人误以为这里
 * 测过。这些约束的存在性由 `plugin-catalog-store.test.ts` 直接从 schema 断言。
 */

/** 测试用的来源标识与包名，与源项目 `open-mcp-market` 的用例保持一致，便于两侧对照。 */
export const TEST_SOURCE_ID = "npm";
export const TEST_PACKAGE_NAME = "acme-investment-team";

/** 测试身份键。 */
export const TEST_IDENTITY = { sourceId: TEST_SOURCE_ID, packageName: TEST_PACKAGE_NAME } as const;

export const TEST_OPERATOR_USER_ID = "user-test";
export const TEST_ORGANIZATION_ID = "org-test";

/**
 * 默认时钟：**固定**在同一时刻。
 *
 * 固定而不是每次前进，是因为「同一毫秒内的两次发布」才是逻辑时钟真正要解决的情形；每次前进的时钟会让
 * `nextMonotonicInstant` 几乎不被触发，规则随之失去覆盖。源项目的用例事实上也在同一毫秒内连续发布。
 */
const FIXED_NOW = new Date("2026-01-01T00:00:00.000Z");

/** 一个渲染必需结构齐备的最小快照 JSON（`parsePackageSnapshot` 的接受面）。 */
export function snapshotJsonOf(version: string, displayName = "投资研究专家团队"): string {
  return JSON.stringify({
    name: TEST_PACKAGE_NAME,
    version,
    description: null,
    keywords: [],
    displayName,
    summary: null,
    agents: [{ id: "financial-analyst", name: "财报解读顾问", description: "分析财务指标" }],
    skills: [],
    servers: [],
    integrity: null,
    tarballUrl: null,
    unpackedSizeBytes: null,
    fileCount: null,
    deprecated: null,
    publishedAt: null,
  });
}

/** 与快照一一对应的摘要；测试用可读值，不追求真实哈希（摘要的生成在 `npm-registry/normalize.ts`）。 */
export function digestOf(version: string): string {
  return `sha256:${version}`;
}

export function publishCommandFor(version: string, overrides: Partial<PublishCommand> = {}): PublishCommand {
  return {
    sourceId: TEST_SOURCE_ID,
    packageName: TEST_PACKAGE_NAME,
    exactVersion: version,
    metadataJson: snapshotJsonOf(version),
    metadataDigest: digestOf(version),
    creationScope: { organizationId: TEST_ORGANIZATION_ID, ownerUserId: TEST_OPERATOR_USER_ID },
    operatorUserId: TEST_OPERATOR_USER_ID,
    requestId: "req-test",
    ...overrides,
  };
}

export function unpublishCommandFor(version: string, overrides: Partial<UnpublishCommand> = {}): UnpublishCommand {
  return {
    sourceId: TEST_SOURCE_ID,
    packageName: TEST_PACKAGE_NAME,
    exactVersion: version,
    operatorUserId: TEST_OPERATOR_USER_ID,
    requestId: "req-test",
    ...overrides,
  };
}

export interface MemoryCatalog {
  /** 把某个精确版本纳入市场，与生产的 `publishVersion` 同序（同一段 {@link runCatalogTurn}）。 */
  publish(
    version: string,
    options?: { now?: Date; metadataJson?: string; metadataDigest?: string },
  ): Promise<PublicationChange>;
  unpublish(version: string, options?: { now?: Date }): Promise<PublicationChange>;
  /** 当前内存状态（不含包时为 null）。 */
  state(): CatalogState | null;
  /** 可见版本，按 `publishedAt DESC, id DESC`；等价于公开面的版本历史。 */
  visibleVersions(): CatalogPublication[];
  /** 某版本的当前行；不存在时为 null。 */
  publicationOf(version: string): CatalogPublication | null;
  /** 审计流水的动作序列，按写入顺序。 */
  auditActions(): string[];
  /** 最近一次决策的写清单；`noop` 断言「零写入」靠它。 */
  lastWrites(): readonly CatalogWrite[];
  /** 直接改写内存状态，用于构造**只能从服务之下到达**的非法或边界状态。 */
  seed(mutate: (draft: MutableCatalogState) => void): void;
  /** 直接插入一条版本行（同样只能从服务之下到达），用于构造「合法但不是最新」的陈旧指针。 */
  seedPublication(input: { id: string; version: string; publishedAt: Date; unpublishedAt?: Date | null }): void;
}

/** 去掉只读修饰，供内存底座改写状态。 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** 种子/改写用的可变状态形状；仅测试面存在。 */
export interface MutableCatalogState {
  package: Mutable<CatalogPackage>;
  publications: Mutable<CatalogPublication>[];
}

/**
 * 创建一个内存目录。
 *
 * 串行化用一条 promise 链实现（`tail.then(...)`）：每次写操作排队等待前一次结束，与生产上
 * `pg_advisory_xact_lock` 对同一包的串行化等价——差别只在于生产跨进程，这里只在本进程内。
 */
export function createMemoryCatalog(state: CatalogState | null = null): MemoryCatalog {
  let current = state;
  const audit: CatalogAuditEntry[] = [];
  let lastWrites: readonly CatalogWrite[] = [];
  let tail: Promise<unknown> = Promise.resolve();

  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const store: CatalogStorePort = {
    async loadState() {
      return current;
    },
    async applyWrites(writes) {
      lastWrites = writes;
      current = applyWritesToState(current, writes);
    },
    async recordAudit(entry) {
      audit.push(entry);
    },
  };

  return {
    publish(version, options = {}) {
      const command = publishCommandFor(version, {
        ...(options.metadataJson === undefined ? {} : { metadataJson: options.metadataJson }),
        ...(options.metadataDigest === undefined ? {} : { metadataDigest: options.metadataDigest }),
      });
      return serialize(() => runCatalogTurn(store, (state) => planPublish(state, command, options.now ?? FIXED_NOW)));
    },
    unpublish(version, options = {}) {
      const command = unpublishCommandFor(version);
      return serialize(() => runCatalogTurn(store, (state) => planUnpublish(state, command, options.now ?? FIXED_NOW)));
    },
    state: () => current,
    visibleVersions: () => (current ? visiblePublications(current) : []),
    publicationOf(version) {
      return current?.publications.find((publication) => publication.exactVersion === version) ?? null;
    },
    auditActions: () => audit.map((entry) => entry.action),
    lastWrites: () => lastWrites,
    seed(mutate) {
      if (!current) throw new Error("内存目录还没有聚合根：先发布一个版本再改写状态");
      const draft: MutableCatalogState = { package: current.package, publications: [...current.publications] };
      mutate(draft);
      current = { package: draft.package, publications: draft.publications };
    },
    seedPublication(input) {
      if (!current) throw new Error("内存目录还没有聚合根");
      const unseen = current.publications.some((publication) => publication.id === input.id);
      if (unseen) throw new Error(`版本行 ${input.id} 已存在`);
      current = {
        package: current.package,
        publications: [
          ...current.publications,
          {
            id: input.id,
            packageId: current.package.id,
            exactVersion: input.version,
            metadataJson: snapshotJsonOf(input.version),
            metadataDigest: digestOf(input.version),
            firstPublishedAt: input.publishedAt,
            publishedAt: input.publishedAt,
            unpublishedAt: input.unpublishedAt ?? null,
            createdAt: input.publishedAt,
            updatedAt: input.publishedAt,
          },
        ],
      };
    },
  };
}

/**
 * 把内存目录接成 Facade 依赖的**目录写端口**（`PluginCatalogPort`）。
 *
 * 两件事同时成立，缺一不可：
 * 1. **状态迁移**交给 {@link createMemoryCatalog}——`visible → noop` / `hidden → restore` / `missing → insert`
 *    这三条分派在真实规则函数上被验证，而不是在一个凭空写的替身上。
 * 2. **命令原样记录下来**——`creationScope`、`operatorUserId`、`requestId` 与快照正文是「Facade 是否把授权结果
 *    正确地带进写入路径」的全部证据，而内存底座的 `publish(version, …)` 只接受版本与快照（它自带测试身份），
 *    因此这些字段只能在适配器这一层断言。
 *
 * 限制：内存底座只有一个聚合根，故本适配器只适用于包名固定为 {@link TEST_PACKAGE_NAME} 的用例。需要跨包场景的
 * 用例应直接构造端口替身，而不是扩宽内存底座——那是往一个「验证规则」的底座里塞测试夹具。
 */
export function createMemoryCatalogPort(catalog: MemoryCatalog): {
  readonly port: PluginCatalogPort;
  /** 端口收到的发布命令，按调用顺序。 */
  readonly publishes: PublishCommand[];
  /** 端口收到的下架命令，按调用顺序。 */
  readonly unpublishes: UnpublishCommand[];
  /** 状态读取的版本序列；用来断言「某条路径读了状态」而不必推断实现细节。 */
  readonly stateReads: string[];
} {
  const publishes: PublishCommand[] = [];
  const unpublishes: UnpublishCommand[] = [];
  const stateReads: string[] = [];

  return {
    port: {
      async getPublicationState(_identity, exactVersion) {
        stateReads.push(exactVersion);
        const publication = catalog.publicationOf(exactVersion);
        if (publication === null) return { state: "missing", publication: null };
        return { state: publication.unpublishedAt === null ? "visible" : "hidden", publication };
      },
      async publish(command) {
        publishes.push(command);
        return catalog.publish(command.exactVersion, {
          metadataJson: command.metadataJson,
          metadataDigest: command.metadataDigest,
        });
      },
      async unpublish(command) {
        unpublishes.push(command);
        return catalog.unpublish(command.exactVersion);
      },
    },
    publishes,
    unpublishes,
    stateReads,
  };
}

/**
 * 把写清单作用到内存状态。
 *
 * 逐条对应仓储的 `applyCatalogWrites`：顺序即语义（下架 latest 时 `set-latest` 排在 `update-publication`
 * 之前），因此这里也必须按数组顺序推演，不能按种类分组。
 */
function applyWritesToState(state: CatalogState | null, writes: readonly CatalogWrite[]): CatalogState | null {
  let next = state;
  for (const write of writes) {
    switch (write.kind) {
      case "create-package":
        next = { package: write.package, publications: next?.publications ?? [] };
        break;
      case "insert-publication": {
        if (!next) throw new Error("写清单在聚合根之前插入了版本行");
        next = { package: next.package, publications: [...next.publications, write.publication] };
        break;
      }
      case "update-publication": {
        if (!next) throw new Error("写清单在聚合根之前更新了版本行");
        // 清单里的版本行是完整行（`planUnpublish` / 恢复分支都由原行展开），因此可以整行替换。
        next = {
          package: next.package,
          publications: next.publications.map((publication) =>
            publication.id === write.publication.id ? write.publication : publication,
          ),
        };
        break;
      }
      case "set-latest": {
        if (!next) throw new Error("写清单在聚合根之前移动了 latest");
        next = {
          package: { ...next.package, latestPublicationId: write.latestPublicationId, updatedAt: write.updatedAt },
          publications: next.publications,
        };
        break;
      }
    }
  }
  return next;
}
