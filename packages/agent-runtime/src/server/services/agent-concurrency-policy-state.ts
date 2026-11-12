import { getAgentRuntimeConfig } from "../config";
import { agentConcurrencyPolicyRepository } from "../repositories/agent-concurrency-policy";
import { AgentConcurrencyPolicyService, type ConcurrencyLimits } from "./agent-concurrency-policy";

/** 唯一运行策略实例；启动装配必须完成 initialize 后才开放流量。 */
export const agentConcurrencyPolicyService = new AgentConcurrencyPolicyService(
  agentConcurrencyPolicyRepository,
  getAgentRuntimeConfig,
);
let limitsReader: ((userId?: string) => ConcurrencyLimits) | undefined;

/** 同步准入共用同一快照，不改变 reservation 的原子区间。 */
export function getAgentConcurrencyLimits(userId?: string): ConcurrencyLimits {
  return limitsReader ? limitsReader(userId) : agentConcurrencyPolicyService.limits(userId);
}

/** 测试依赖注入入口；生产始终使用持久化策略快照。 */
export function setAgentConcurrencyLimitsReaderForTest(reader?: (userId?: string) => ConcurrencyLimits): void {
  limitsReader = reader;
}
