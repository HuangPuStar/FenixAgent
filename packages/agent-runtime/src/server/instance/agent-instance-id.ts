import { randomUUID } from "node:crypto";

const AGENT_INSTANCE_UID_PATTERN = /^inst_[0-9a-f]{32}$/;

/** 生成稳定 Agent Instance 业务标识。 */
export function createAgentInstanceUid(): string {
  return `inst_${randomUUID().replaceAll("-", "")}`;
}

/** 校验 Agent Instance 业务标识格式。 */
export function isAgentInstanceUid(value: string): boolean {
  return AGENT_INSTANCE_UID_PATTERN.test(value);
}
