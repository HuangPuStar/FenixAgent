import * as agentMemoryConfigRepo from "../repositories/agent-memory-config";
import { getHindsightConfig } from "./hindsight";

// ────────────────────────────────────────────
// 记忆开关——权威判断入口
//
// 两级模型：
//   1. 系统级：memory 模块配置是否给出 Hindsight 地址（基础设施可用性）
//   2. Agent 级：agent_memory_config.enabled（用户开关）
//
// 所有需要判断"记忆是否可用"的调用方，统一经过此 service，
// 禁止各自内联查表、解析 extra.plugin 或直读环境变量。
// ────────────────────────────────────────────

/**
 * Hindsight 插件运行时默认参数（不存储于数据库，运行时动态构造）。
 *
 * **刻意不写 `retainTags`**：插件默认值是 `['{session_id}']`（`src/lib/config.ts:115`），会话标签是
 * `recallTags` 过滤能成立的前提——文档已写入就无法事后补打（同文件 :111-115 的注释）。托管文件是插件
 * 配置的最高层，一旦在这里写 `retainTags: []`，会话标签会被对所有引擎静默关闭；需要限制标签时应由
 * 平台显式给出非空集合。`dynamicBankId` / `bankIdPrefix` / `directoryBankMap` 等隔离键不在本表内，
 * 由启动参数组装器在托管文件里单独钉死（见 `@fenix/agent-config` 的 `agent-launch-spec/memory-env`）。
 */
export const HINDSIGHT_PLUGIN_DEFAULTS: Record<string, unknown> = {
  autoRecall: true,
  autoRetain: true,
  recallBudget: "mid",
  recallTags: [],
  recallTagsMatch: "any",
  retainEveryNTurns: 3,
  debug: false,
};

/**
 * 系统级：Hindsight 基础设施是否可用（memory 模块配置已给出服务地址）。
 *
 * 「部署未设置 HINDSIGHT_MCP_URL」经宿主映射后是「模块配置里 hindsightMcpUrl 为空」，这里返回
 * false，与迁移前的 env 判定行为一致。两种异常仍会抛出而不被吞掉：宿主未装配模块配置（平台契约
 * 的既定语义）与配置形状非法（`getMemoryConfig()` 的 schema 校验）。
 */
export function isHindsightAvailable(): boolean {
  return getHindsightConfig() !== null;
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
