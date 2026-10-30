import { AppError } from "@fenix/platform-sdk";
import { createAgentInstanceUid } from "../instance/agent-instance-id";
import { type AgentInstanceRecord, agentInstanceRepo } from "../repositories/agent-instance";

/**
 * 查找或创建具名 `api` 持久实例。
 *
 * IM 每聊天一个专属实例（`im-<conversationId>`，规格 §11.20 / §11.23），与 HTTP 的 `api/primary` 分开。
 * `creation_source` 固定 `api`，生命周期沿用既有空闲回收，不引入 IM 专属 TTL。
 */
export function findOrCreateNamedApiInstance(input: {
  environmentId: string;
  ownerUserId: string;
  name: string;
}): Promise<AgentInstanceRecord> {
  const name = input.name.trim();
  if (!input.ownerUserId) throw new AppError("Agent Instance owner is required", "INSTANCE_OWNER_REQUIRED", 400);
  if (!name || name.length > 100 || name === "default") {
    throw new AppError("Invalid Agent Instance name", "INSTANCE_NAME_INVALID", 400);
  }
  return agentInstanceRepo.findOrCreateByCreationKey({
    id: createAgentInstanceUid(),
    environmentId: input.environmentId,
    ownerUserId: input.ownerUserId,
    creationSource: "api",
    name,
    isDefault: false,
    createdByUserId: input.ownerUserId,
  });
}
