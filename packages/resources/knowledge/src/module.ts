import type {
  IAgentKnowledgeBindingRepo,
  IKnowledgeBaseRepo,
  IKnowledgeResourceRepo,
} from "./server/repositories/knowledge-base";
import {
  agentKnowledgeBindingRepo,
  knowledgeBaseRepo,
  knowledgeResourceRepo,
} from "./server/repositories/knowledge-base";

/**
 * Knowledge 模块的运行时表面。
 *
 * 只暴露需要"对象身份"的能力：三张表（知识库 / 知识资源 / agent 知识库绑定）的仓储单例——它们是本包
 * 唯一的数据访问点，跨包调用方（如 `@fenix/agent-config` 的绑定校验）拿到的是同一批实例，再构造一套
 * 等于给同一张表开两条查询路径。与 `@fenix/resource-task`、`@fenix/resource-prod-view` 的组合根同口径。
 *
 * 服务端能力（知识库领域规则、RAGFlow provider、健康检查、运行时检索）与路由工厂都是无状态函数或
 * 工厂，经 `./server` 直接调用即可；在这里再包一层只会多出一条与 `./server` 重复的公开面。
 *
 * 存在的另一个意义是 manifest 的惰性 `create` 需要一个入口：模块索引层只 import 本文件，装配期
 * 才按需加载 `./server` 图（Drizzle、Elysia 与知识库服务全在那个图里）。
 */
export interface KnowledgeModule {
  readonly id: "knowledge";
  /** 知识库仓储：`knowledge_base` 表的唯一数据访问点。 */
  readonly knowledgeBases: IKnowledgeBaseRepo;
  /** 知识资源仓储：`knowledge_resource` 表的唯一数据访问点。 */
  readonly resources: IKnowledgeResourceRepo;
  /** Agent 知识库绑定仓储：`agent_knowledge_binding` 表的唯一数据访问点。 */
  readonly bindings: IAgentKnowledgeBindingRepo;
}

/** 创建 Knowledge 模块实例；仓储是进程级单例，重复调用不产生第二份数据访问路径。 */
export function createKnowledgeModule(): KnowledgeModule {
  return {
    id: "knowledge",
    knowledgeBases: knowledgeBaseRepo,
    resources: knowledgeResourceRepo,
    bindings: agentKnowledgeBindingRepo,
  };
}
