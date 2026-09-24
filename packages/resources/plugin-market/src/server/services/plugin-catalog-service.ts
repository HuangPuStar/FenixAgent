import { getPluginMarketDatabase } from "../db";
import { findPublicationState, planPublish, planUnpublish } from "../domain/catalog";
import type {
  CatalogAuditEntry,
  CatalogDecision,
  CatalogState,
  CatalogWrite,
  PublicationChange,
  PublicationState,
  PublishCommand,
  UnpublishCommand,
} from "../domain/types";
import { recordAdminOperation } from "../repositories/plugin-audit";
import {
  applyCatalogWrites,
  loadCatalogState,
  type PackageIdentity,
  withPackageLock,
} from "../repositories/plugin-package";

/**
 * 目录编排：把「取锁 → 读状态 → 纯规则决策 → 落写清单 + 审计」串成一次事务。
 *
 * 编排之所以薄，是因为规则全部在 `../domain/catalog.ts` 的纯函数里：本文件负责的只有两件领域不需要知道的事
 * ——**并发边界**（事务 + 咨询锁）与**持久化顺序**（写清单按序执行）。
 *
 * 时刻由调用方传入（默认取当前时间）而不是在领域内部取 `new Date()`：逻辑时钟的正确性完全依赖「候选时刻
 * 可与已记录时刻比较」，测试必须能固定它，否则「恢复必须前移」这类规则只能靠等待时间来触发。
 */

/**
 * 目录事务的存储端口。
 *
 * 存在的理由是**测试进程里没有 Postgres**：规则可以在内存里跑，但事务序列（先读后判、按序落库、审计只在
 * 真实变更时写）如果只存在于生产代码里，就会退化成「测试自己重写一遍序列」——那样测试断言的是重写版，
 * 而不是真正跑在生产上的顺序。抽出这三步之后，两侧共用 {@link runCatalogTurn}，每个端口实现只剩「怎么读、
 * 怎么写」这一层，且由 `plugin-catalog-store.test.ts` 单独钉住生产实现。
 */
export interface CatalogStorePort {
  loadState(): Promise<CatalogState | null>;
  applyWrites(writes: readonly CatalogWrite[]): Promise<void>;
  recordAudit(entry: CatalogAuditEntry): Promise<void>;
}

/**
 * 一次写操作的时序：读状态 → 决策 → 落写清单 → 记审计。
 *
 * 「读在判断之前」不是顺序偏好而是正确性前提：清单（写什么）由读到的那份状态推出来，中间插进任何一次写
 * 都会让判定和落库基于两份不同的状态——`noop` 的判定尤其如此（它断言的是「这一刻库里已经是你想要的样子」）。
 */
export async function runCatalogTurn<T>(
  store: CatalogStorePort,
  decide: (state: CatalogState | null) => CatalogDecision<T>,
): Promise<T> {
  const state = await store.loadState();
  const decision = decide(state);
  await store.applyWrites(decision.writes);
  if (decision.audit) await store.recordAudit(decision.audit);
  return decision.result;
}

/** 生产侧的一次事务：先在锁内拿到事务句柄，再把仓储原语包成存储端口。 */
async function runLockedTurn<T>(
  identity: PackageIdentity,
  decide: (state: CatalogState | null) => CatalogDecision<T>,
): Promise<T> {
  return withPackageLock(identity, (tx) =>
    runCatalogTurn(
      {
        loadState: () => loadCatalogState(tx, identity),
        applyWrites: (writes) => applyCatalogWrites(tx, writes),
        recordAudit: (entry) => recordAdminOperation(tx, entry),
      },
      decide,
    ),
  );
}

/** 把某个精确版本纳入市场（`missing` 时新建、`hidden` 时恢复、`visible` 时幂等无操作）。 */
export async function publishVersion(command: PublishCommand, now: Date = new Date()): Promise<PublicationChange> {
  return runLockedTurn(command, (state) => planPublish(state, command, now));
}

/** 下架某个精确版本。最后一个可见版本被下架后，整个包从公开面消失。 */
export async function unpublishVersion(command: UnpublishCommand, now: Date = new Date()): Promise<PublicationChange> {
  return runLockedTurn(command, (state) => planUnpublish(state, command, now));
}

/**
 * 读某个精确版本此刻的位置；**不开事务、不加锁**。
 *
 * 它服务的是「要不要回源重读 registry」的分派决策（见 Facade 的发布路径）：`visible` 直接幂等返回、`hidden`
 * 复用库内快照恢复，只有 `missing` 才需要一次网络读取。这个读本身没有副作用，重复执行或读到稍旧的状态都
 * 只影响「是否多读一次 registry」，而真正的写路径会在锁内重新判定一次——因此这里刻意不引入锁，避免为了
 * 一次只读查询去序列化整个包的写入。
 */
export async function getPublicationState(identity: PackageIdentity, exactVersion: string): Promise<PublicationState> {
  const state = await loadCatalogState(getPluginMarketDatabase(), identity);
  return findPublicationState(state, exactVersion);
}
