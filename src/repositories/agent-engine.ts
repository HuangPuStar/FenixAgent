import type { AgentEngineData, AgentEngineRepo } from "@fenix/orchestration";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentConfig } from "../db/schema";

/**
 * 编排域 AgentEngineRepo 的 PostgreSQL 实现。
 *
 * DB 没有独立的 agent_engine 表：引擎类型是 `agent_config.engine_type` 列上的字符串
 * （"opencode" / "claude-code" / "ccb" / "peri"）。因此“引擎存在性”以该引擎类型是否被任一
 * agent_config 实际引用为准（SELECT DISTINCT engine_type）。
 */
export class PgAgentEngineRepo implements AgentEngineRepo {
  /**
   * 按引擎 ID（即 engine_type 字符串）读取引擎信息；agent_config 中无该引擎类型的
   * 记录时返回 `null`。
   *
   * 映射说明：
   *   - `id` / `type`：引擎标识即 engine_type 本身，直接透传（"opencode" → "opencode"）；
   *   - `version`：无版本表来源，统一给 `"latest"` 占位。移除条件：引入引擎版本
   *     管理（如 machine 上报的引擎版本）后，改为从版本来源解析。
   */
  async getEngine(engineId: string): Promise<AgentEngineData | null> {
    const rows = await db
      .selectDistinct({ engineType: agentConfig.engineType })
      .from(agentConfig)
      .where(eq(agentConfig.engineType, engineId))
      .limit(1);

    if (rows.length === 0) return null;

    return { id: engineId, type: engineId, version: "latest" };
  }
}

/** 编排域 AgentEngineRepo 单例。 */
export const agentEngineRepo = new PgAgentEngineRepo();
