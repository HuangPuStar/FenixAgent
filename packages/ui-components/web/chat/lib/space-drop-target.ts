/**
 * space 归属的放置决策与乐观覆盖（纯逻辑）。
 *
 * 与 `space-grouping.ts` 的分工：那边回答「谁在哪个分组里」，这里回答「把谁放到哪儿」以及
 * 「宿主快照回来之前界面先怎么画」。两者都不碰 DOM 与 React。
 *
 * 本模块是包内实现细节，不进 `exports`：唯一消费方是本包侧栏
 * （`shell/sidebar-session-list.tsx` 与 `shell/internal/space-group-section.tsx`），
 * 拖放决策不是宿主的职责，扩大出口只会让宿主以为自己该接一层。
 */

import type { ChatSpaceItem } from "../shell/chat-interface-types";
import type { ChatSpaceGroup } from "./space-grouping";

/**
 * 「默认」分组的放置目标 id。
 *
 * 默认分组没有 space id（它的语义就是「没有归属」），但 dnd-kit 的 id 空间里需要占位符。
 * 取值刻意用 `space:__default__` 这种远离 nanoid / uuid 形状的串：真实 space id 若与哨兵相同，
 * 那个分组的放置目标会与默认分组撞成一个 id，dnd-kit 会只认其中一个，静默地丢掉落点。
 */
export const DEFAULT_SPACE_DROP_ID = "space:__default__";

/** 分组 → 放置目标 id（默认分组用哨兵，真实分组加前缀）。 */
export function toSpaceDropId(spaceId: string | null): string {
  return spaceId === null ? DEFAULT_SPACE_DROP_ID : `space:${spaceId}`;
}

/** 一次放置要落到的归属；调用方据此在 `onAssignSession` / `onUnassignSession` 之间二选一。 */
export type SpaceDropIntent = { kind: "assign"; spaceId: string } | { kind: "unassign" };

/**
 * 把「拖起的会话 + 松手处的放置目标」翻译成一次归属写入；返回 `null` 表示这次放置不该改任何东西。
 *
 * 语义（越界输入一律容忍，不抛错）：
 * - `overId` 为空（松手在列表之外）或不在 `groups` 里（别的 Droppable、已消失的分组）→ 不改。
 * - 目标分组与当前分组相同（含「默认 → 默认」）→ 不改：写进去也只会得到同一份归属，
 *   却要多打一次网络请求，并让乐观覆盖与宿主快照白白经历一次往返。
 * - 拖到「默认」分组 → `unassign`：默认分组的语义是未被任何 space 认领。
 * - 会话不在任何已渲染分组里（宿主快照与拖起的行不同步）→ 按「当前无归属」处理，
 *   因此拖到默认分组是不改，拖到某个 space 是 assign（幂等写，后端按「至多属于一个分组」收敛）。
 *
 * @param sessionId 被拖起的会话
 * @param overId 松手处 dnd-kit 放置目标 id（`null` / `undefined` 表示没有落点）
 * @param groups 当前渲染的分组（顺序无关，按 id 匹配）
 */
export function resolveDropTarget(
  sessionId: string,
  overId: string | null | undefined,
  groups: readonly ChatSpaceGroup[],
): SpaceDropIntent | null {
  if (!overId) return null;
  const target = groups.find((group) => toSpaceDropId(group.spaceId) === overId);
  if (!target) return null;

  const owner = groups.find((group) => group.sessions.some((session) => session.sessionId === sessionId));
  if ((owner?.spaceId ?? null) === target.spaceId) return null;

  return target.spaceId === null ? { kind: "unassign" } : { kind: "assign", spaceId: target.spaceId };
}

/** 乐观归属覆盖表：sessionId → 目标 spaceId（`null` = 移出归属）。 */
export type SpaceAssignmentOverrides = ReadonlyMap<string, string | null>;

/** 空覆盖表（稳定引用：让「没有本地覆盖」这条路径不产生新的列表引用与重算）。 */
export const NO_ASSIGNMENT_OVERRIDES: SpaceAssignmentOverrides = new Map();

/**
 * 把乐观覆盖叠加到宿主快照上，产出分组计算真正消费的列表。
 *
 * 叠加而非替换：覆盖只描述被拖动过的那几个会话，其余分组与顺序仍以宿主快照为准。
 * 同一个会话先被移出旧分组、再按覆盖落到新分组，两次改写都在这里完成，
 * 因此界面不会出现「同时属于两个分组」的中间态（`groupBySpace` 的顺序去重只是兜底）。
 *
 * @param spaces 宿主快照
 * @param overrides 乐观覆盖表
 */
export function applyAssignmentOverrides(
  spaces: readonly ChatSpaceItem[],
  overrides: SpaceAssignmentOverrides,
): readonly ChatSpaceItem[] {
  if (overrides.size === 0) return spaces;
  const moved = new Set(overrides.keys());
  return spaces.map((space) => ({
    ...space,
    sessionIds: [
      ...space.sessionIds.filter((sessionId) => !moved.has(sessionId)),
      ...[...overrides].filter(([, spaceId]) => spaceId === space.id).map(([sessionId]) => sessionId),
    ],
  }));
}

/**
 * 宿主快照已经体现的覆盖从表里退场；返回同一实例表示无变化。
 *
 * 覆盖必须靠「快照追上来」而不是「写入成功」退场：写入成功到重取列表之间有真实的时间差
 * （宿主是 `refresh()` fire-and-forget），此刻撤掉覆盖会让会话先跳回旧分组再跳回来。
 * 反过来，快照迟迟不回（重取失败）时覆盖会一直挂着，表现为「本地记住了用户最后那次移动」——
 * 比闪回旧状态更接近事实，代价是该会话在宿主数据修好前不再跟随远端变化。
 *
 * @param spaces 宿主快照
 * @param overrides 乐观覆盖表
 */
export function pruneSettledOverrides(
  spaces: readonly ChatSpaceItem[],
  overrides: SpaceAssignmentOverrides,
  pendingSessionIds: ReadonlySet<string> = new Set(),
): SpaceAssignmentOverrides {
  if (overrides.size === 0) return overrides;
  const settled: string[] = [];
  for (const [sessionId, spaceId] of overrides) {
    // A→B→A 尚未落库时旧 A 快照也会相等，不能据此丢掉最后一次意图。
    if (pendingSessionIds.has(sessionId)) continue;
    const owner = spaces.find((space) => space.sessionIds.includes(sessionId));
    if ((owner?.id ?? null) === spaceId) settled.push(sessionId);
  }
  if (settled.length === 0) return overrides;
  const next = new Map(overrides);
  for (const sessionId of settled) next.delete(sessionId);
  return next;
}
