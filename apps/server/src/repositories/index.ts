// 宿主装配所需的仓储；不重复定义查询条件。
// 身份表由 `@fenix/identity` 拥有（CE 阶段 2 任务 1.2），身份仓储直接从该包导入——本处曾转发
// `organizationRepo`，但全仓无消费者，已按「删除优于兼容」移除，避免留一个零读者的转发面。
export type {
  AgentKnowledgeBindingRow,
  IAgentKnowledgeBindingRepo,
  IKnowledgeBaseRepo,
  IKnowledgeResourceRepo,
  KnowledgeBaseRow,
  KnowledgeResourceRow,
} from "@fenix/resource-knowledge/server";
export { agentKnowledgeBindingRepo, knowledgeBaseRepo, knowledgeResourceRepo } from "@fenix/resource-knowledge/server";
export { agentEngineRepo } from "./agent-engine";
