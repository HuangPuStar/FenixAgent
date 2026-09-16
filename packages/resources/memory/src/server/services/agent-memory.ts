import * as agentMemoryConfigRepo from "../repositories/agent-memory-config";

// ────────────────────────────────────────────
// 记忆开关——权威判断入口
//
// 两级模型：
//   1. 系统级：HINDSIGHT_MCP_URL 是否配置（基础设施可用性）
//   2. Agent 级：agent_memory_config.enabled（用户开关）
//
// 所有需要判断"记忆是否可用"的调用方，统一经过此 service，
// 禁止各自内联查表或解析 extra.plugin。
// ────────────────────────────────────────────

/** Hindsight 插件运行时默认参数（不存储于数据库，运行时动态构造） */
export const HINDSIGHT_PLUGIN_DEFAULTS: Record<string, unknown> = {
  autoRecall: true,
  autoRetain: true,
  recallBudget: "mid",
  recallTags: [],
  recallTagsMatch: "any",
  retainTags: [],
  retainEveryNTurns: 3,
  debug: false,
};

/** 系统级：Hindsight 基础设施是否可用（HINDSIGHT_MCP_URL 已配置） */
export function isHindsightAvailable(): boolean {
  return Boolean(process.env.HINDSIGHT_MCP_URL);
}

/** Agent 级：指定 Agent 的记忆是否已启用 */
export async function isAgentMemoryEnabled(agentConfigId: string): Promise<boolean> {
  const config = await agentMemoryConfigRepo.getByAgentConfigId(agentConfigId);
  return config?.enabled === true;
}

/** 组合判断：系统可用 AND Agent 启用 → 记忆可以生效 */
export async function shouldEnableAgentMemory(agentConfigId: string): Promise<boolean> {
  if (!isHindsightAvailable()) return false;
  return isAgentMemoryEnabled(agentConfigId);
}
