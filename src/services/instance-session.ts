/**
 * 实例会话标识 — agent_session 表废弃后的确定性替代。
 *
 * I4 集成第五阶段：agent_session 表已废弃，不再持久化 "Instance N" 标题会话。
 * 实例会话标识改为确定性生成：同一 environment + 同一 instanceNumber 始终得到
 * 相同 ID，供前端透传（POST /web/environments/:id/enter 返回的 session_id →
 * YJS WS URL query），并在 YJS WS 连接时解析回实例编号，实现多实例 YJS doc 隔离。
 *
 * 注意：此标识是 RCS 侧的前端会话标识，与 ACP 协议的 `ses_*` session id 无关；
 * 它以 `ses_inst_` 为前缀以与历史 `session_*` 格式区分，解析失败即视为无效会话。
 */

/** 实例会话 ID 前缀 */
const INSTANCE_SESSION_PREFIX = "ses_inst_";

/**
 * 生成确定性实例会话 ID。
 * 格式：ses_inst_{environmentId}_{instanceNumber}
 */
export function createInstanceSessionId(environmentId: string, instanceNumber: number): string {
  return `${INSTANCE_SESSION_PREFIX}${environmentId}_${instanceNumber}`;
}

/**
 * 从实例会话 ID 解析环境与实例编号。
 * environmentId 允许包含任意字符（含下划线），通过贪婪匹配最后一个 `_数字` 后缀拆分；
 * 无法解析时返回 null（调用方应保守拒绝）。
 */
export function parseInstanceSessionId(sessionId: string): { environmentId: string; instanceNumber: number } | null {
  const match = sessionId.match(new RegExp(`^${INSTANCE_SESSION_PREFIX}(.+)_(\\d+)$`));
  if (!match) return null;
  return { environmentId: match[1], instanceNumber: parseInt(match[2], 10) };
}
