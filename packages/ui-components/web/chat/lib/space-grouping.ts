/**
 * 会话列表按 space（会话空间）分组（纯函数）。
 *
 * 与 `session-grouping.ts` 的时间分组互斥：宿主未注入 space 数据时侧栏仍走「今天/昨天/更早」，
 * 注入后组顺序为「各 space（宿主数组顺序，即创建时间倒序）」+「默认」固定在最底。组内排序共用
 * `sortByRecencyDesc`，两条路径的"最近优先"语义因此保持一致。
 */

import type { ChatSpaceItem } from "../shell/chat-interface-types";
import type { SessionSummary } from "../types";
import { sortByRecencyDesc } from "./session-grouping";

/** space 分组条目。 */
export interface ChatSpaceGroup {
  /** 分组标识；null 表示「默认」分组（未被任何 space 认领的会话） */
  spaceId: string | null;
  /** 分组名称；默认分组取传入的本地化文案 */
  name: string;
  /** 是否可重命名：默认分组是兜底容器，不承载用户命名语义 */
  canRename: boolean;
  /** 组内会话（按 updatedAt 降序） */
  sessions: SessionSummary[];
}

/**
 * 将会话按 space 分组；返回「各 space + 默认分组」的固定顺序。
 *
 * 归属语义（越界输入一律容忍，不抛错）：
 * - 一个会话只归第一个认领它的 space（按 spaces 顺序），同一 space 内的重复 id 只算一次。
 * - `sessionIds` 里已不存在的会话 id（agent 侧已删除）忽略，不制造幽灵行。
 * - 未被任何 space 认领的会话落「默认」分组；该分组恒为**最后一组**（即使为空），
 *   因为「在默认分组里新建会话」是一个可用入口，不能随内容消失。
 * - 空 space 保留：分组是「可以往里放会话」的容器，折叠状态与新建入口都依赖它存在。
 *
 * 顺序口径：spaces 数组顺序即分组展示顺序（宿主按创建时间倒序下发，新建的分组因此在最上面），
 * 默认分组恒定在最后。落点判定按分组 id 匹配（`lib/space-drop-target`），不依赖顺序。
 *
 * @param sessions 会话列表（顺序无关，组内会重新排序）
 * @param spaces 空间列表（顺序即展示顺序）
 * @param defaultSpaceLabel 「默认」分组的本地化文案
 */
export function groupBySpace(
  sessions: readonly SessionSummary[],
  spaces: readonly ChatSpaceItem[],
  defaultSpaceLabel: string,
): ChatSpaceGroup[] {
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
  const claimed = new Set<string>();

  const spaceGroups: ChatSpaceGroup[] = spaces.map((space) => {
    const members: SessionSummary[] = [];
    for (const sessionId of space.sessionIds) {
      const session = sessionById.get(sessionId);
      if (!session || claimed.has(sessionId)) continue;
      claimed.add(sessionId);
      members.push(session);
    }
    return { spaceId: space.id, name: space.name, canRename: true, sessions: sortByRecencyDesc(members) };
  });

  const unassigned = sessions.filter((session) => !claimed.has(session.sessionId));
  return [
    ...spaceGroups,
    {
      spaceId: null,
      name: defaultSpaceLabel,
      canRename: false,
      sessions: sortByRecencyDesc(unassigned),
    },
  ];
}
