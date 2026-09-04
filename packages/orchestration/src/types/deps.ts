/**
 * 编排域与数据访问层之间的仓库接口契约。
 *
 * 这些接口是编排域（AgentController / AgentNode / Instance）获取持久化数据的唯一入口，
 * 具体实现由宿主应用（`src/repositories/`）提供并注入。接口只描述编排域所需的最小数据形状，
 * 不绑定任何 ORM 或存储实现；数据形状与 I1 设计文档保持一致。
 */

/** Agent 配置的扁平聚合视图，供 LaunchSpec 构建使用。 */
export interface AgentConfigData {
  id: string;
  name: string;
  systemPrompt: string | null;
  modelProviderId: string;
  modelName: string;
  /** 引擎引用（对应 DB `agent_config.engine_type`），LaunchSpec 构建时经 AgentEngineRepo 解析为引擎信息。 */
  engineId: string;
  skills: { skillId: string; name: string }[];
  mcpServers: { mcpServerId: string; name: string }[];
  knowledgeBases: { kbId: string; name: string }[];
}

/** Agent 配置仓库：按配置 ID 读取扁平配置。 */
export interface AgentConfigRepo {
  getConfig(configId: string): Promise<AgentConfigData | null>;
}

/** 环境（Environment）的领域数据视图。 */
export interface EnvironmentData {
  id: string;
  /** 所属组织，LaunchSpec 的 workspace 路径按 `{root}/{organizationId}/{userId}/{environmentId}` 计算。 */
  organizationId: string;
  /**
   * 绑定的 Agent 配置 ID；null 表示环境未绑定（ACP/Bridge 注册路径创建的环境）。
   * 宿主 Repo 不得因 agentConfigId 缺失而返回 null——agentConfig 必填约束由
   * LaunchSpecBuilder 在 build 时校验（LaunchSpecBuildError），machineId fallback
   * 仍须正常执行。
   */
  agentConfigId: string | null;
  /** 目标机器；宿主 Repo 实现负责默认值 fallback，编排域不读取环境变量。 */
  machineId: string | null;
  autoStart: boolean;
}

/** 环境仓库：按环境 ID 读取环境数据。 */
export interface EnvironmentRepo {
  /**
   * 读取环境数据；`userId` 为请求者标识（实例资源归属）。
   *
   * 宿主 Repo 在解析 machineId 时可用它做资源归属决策（如 sandbox 执行节点按
   * `pool + userId` 复用实例）；不需要时实现可忽略。调用方（AgentController /
   * LaunchSpecBuilder）必须透传 spawn 流程的 userId。
   */
  getEnvironment(envId: string, userId?: string): Promise<EnvironmentData | null>;
}

/** 远程 Agent 机器（Machine）的连接元数据。 */
export interface AgentMachineData {
  id: string;
  host: string;
  port: number;
}

/** 机器仓库：按机器 ID 读取连接元数据。 */
export interface AgentMachineRepo {
  getMachine(machineId: string): Promise<AgentMachineData | null>;
}

/** Agent 引擎（Engine）的版本元数据。 */
export interface AgentEngineData {
  id: string;
  type: string;
  version: string;
}

/** 引擎仓库：按引擎 ID 读取引擎信息。 */
export interface AgentEngineRepo {
  getEngine(engineId: string): Promise<AgentEngineData | null>;
}
