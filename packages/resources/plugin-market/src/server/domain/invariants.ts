import { newestVisiblePublication, visiblePublications } from "./catalog";
import type { CatalogState } from "./types";

/**
 * 三条 latest 不变量的**只读**审计。
 *
 * 为什么规则要有独立检查而不是只靠写入路径自律：写入路径的每一条分支都可能在重构中被绕开，而这几条不变量
 * 的破坏**不会引发任何报错**——它只表现为「首页显示的版本不是最新版」「下架后包还在列表里」这类温和症状，
 * 没人会把它和一次发布操作联系起来。因此这里提供一份「不修数据、只报违规」的审计，供测试与运维诊断使用。
 *
 * 三条规则与源项目（`open-mcp-market` 的 `catalog/repository.ts#findInvariantViolations`）逐条对应，消息
 * 文本也保持一致，便于两侧对照：
 * 1. 有可见版本 ⇒ 必须有 latest（否则整个包对非写权主体消失）；
 * 2. latest 必须指向**本包的、可见的**版本（存储层由复合外键强保证「本包」，本条覆盖「可见」）；
 * 3. latest 必须等于**最新**可见版本（按 `publishedAt DESC, id DESC`）。
 *
 * 第 3 条是最容易被漏掉的一条：指针仍指向一个**合法但陈旧**的可见版本时，前两条都通过，只有第 3 条会报。
 * 因此第 3 条只在第 1、2 条通过时才运行，保证**一个缺陷只被一条规则报告**（否则同一个坏指针会产出两条
 * 消息，运维会以为有两个问题）。
 *
 * 规则 2、3 在源项目里是 SQLite 触发器，在本仓库是「应用层顺序保证 + 本审计」——理由见 `db/schema.ts`
 * 的不变量承载说明（迁移链由 Drizzle 生成，不引入手写 PL/pgSQL 触发器）。
 */
export function findInvariantViolations(state: CatalogState): string[] {
  const packageId = state.package.id;
  const latestId = state.package.latestPublicationId;

  if (latestId === null) {
    // 规则 1：没有指针时，任何可见版本都是「孤儿」——包还在库里，却永远不会出现在任何列表里。
    if (visiblePublications(state).length > 0) {
      return [`package ${packageId} has visible publications but no latest`];
    }
    return [];
  }

  // 规则 2：指针要么悬空（指向别的包的版本，或本包已下架的版本），要么合法。
  const pointed = state.publications.find((publication) => publication.id === latestId) ?? null;
  if (!pointed || pointed.packageId !== packageId || pointed.unpublishedAt !== null) {
    return [`package ${packageId} latest is not a visible publication of the same package`];
  }

  // 规则 3：指针必须指向排序意义上的第一条可见版本。
  const newest = newestVisiblePublication(state);
  if (!newest || newest.id !== latestId) {
    return [`package ${packageId} latest ${latestId} is not the newest visible publication`];
  }

  return [];
}
