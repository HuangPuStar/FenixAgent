/**
 * IM 实例命名规则：一个 IM 聊天对应一个长期实例，名称由会话映射 id 派生。
 * 宿主创建实例与控制面展示必须共用这一处，否则改名只会更新一半。
 */
export function buildImInstanceName(conversationId: string): string {
  return `im-${conversationId}`;
}
