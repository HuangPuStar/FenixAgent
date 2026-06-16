import type { AgentSessionInfo } from "../../src/acp/types";

/**
 * 按日期分组的会话列表条目
 * 复用场景：ACPMain 左侧 SidebarSessionList、ChatHeader popover 中的历史会话列表
 */
export interface SessionGroup {
  /** 分组展示文案（已国际化） */
  label: string;
  /** 分组内的会话列表（已按 updatedAt 降序） */
  sessions: AgentSessionInfo[];
}

/**
 * 将会话列表按"今天 / 昨天 / 更早"三档分组。
 *
 * 输入无需预排序，函数内部按 updatedAt 降序排列后再分组。
 * 缺失 updatedAt 的会话视为最早（落在"更早"分组顶部）。
 * 空分组会被剔除，保证返回结果只含有内容的分组。
 *
 * @param sessions 原始会话列表
 * @param labels 三档分组的本地化文案
 */
export function groupByRecency(
  sessions: AgentSessionInfo[],
  labels: { today: string; yesterday: string; earlier: string },
): SessionGroup[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);

  const groups: SessionGroup[] = [
    { label: labels.today, sessions: [] },
    { label: labels.yesterday, sessions: [] },
    { label: labels.earlier, sessions: [] },
  ];

  // 按 updatedAt 降序排列，使每个分组内的会话呈现"最近优先"
  const sorted = [...sessions].sort((a, b) => {
    const dateA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const dateB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return dateB - dateA;
  });

  for (const session of sorted) {
    const date = session.updatedAt ? new Date(session.updatedAt) : new Date(0);
    if (date >= today) {
      groups[0].sessions.push(session);
    } else if (date >= yesterday) {
      groups[1].sessions.push(session);
    } else {
      groups[2].sessions.push(session);
    }
  }

  return groups.filter((g) => g.sessions.length > 0);
}
