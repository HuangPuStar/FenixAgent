type SendSessionAction = (action: Record<string, unknown>) => boolean;

/**
 * 发送会话变更，并在成功写入连接后追加一次列表查询。
 *
 * Session Doc 仍是列表的唯一数据源；这里仅缩短下一次权威列表同步的等待时间。
 */
export function sendSessionMutationWithRefresh(
  mutation: Record<string, unknown>,
  sendMutation: SendSessionAction,
  sendRefresh: SendSessionAction,
  refreshCommandId: string,
): boolean {
  const sent = sendMutation(mutation);
  if (sent) sendRefresh({ action: "list_sessions", commandId: refreshCommandId });
  return sent;
}
