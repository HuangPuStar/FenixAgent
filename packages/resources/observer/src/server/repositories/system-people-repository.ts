import { agentConfig } from "@server/db/schema";
import { asc, eq } from "drizzle-orm";
import { getObserverDatabase } from "../db";

/**
 * 系统人员树的唯一数据访问点（`agent_config` 的只读归属查询）。
 *
 * 为什么单独成层：查询条件与投影列属于持久化知识，服务层只应表达「按组织取智能体归属」这一业务意图。
 * 表定义今天仍来自宿主 `@server/db/schema`（表定义迁出归任务 1.7，计划 §5 的残留），因此这里是本包
 * 唯一允许接触持久化模型的文件——服务层不再直接 import DB 句柄或表对象。
 *
 * 句柄在函数内取（`getObserverDatabase()`）：模块加载期宿主可能尚未完成基础设施初始化，
 * 在模块顶层固化句柄会让导入顺序变成隐式启动依赖。
 */

/** 人员树需要的智能体归属投影：只取展示与分组必需的列，不整行返回。 */
export interface SystemPeopleAgentRow {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  machineId: string | null;
  engineType: string | null;
}

/**
 * 按组织列出智能体配置归属。
 *
 * 排序在 SQL 内完成（name → id）：服务层会对用户分组再次排序，若这里不确定顺序，同一份数据在
 * 不同数据库执行计划下的输出会不同，断言与界面都会抖动。
 */
export async function listAgentConfigsByOrganization(organizationId: string): Promise<SystemPeopleAgentRow[]> {
  return getObserverDatabase()
    .select({
      id: agentConfig.id,
      userId: agentConfig.userId,
      name: agentConfig.name,
      description: agentConfig.description,
      machineId: agentConfig.machineId,
      engineType: agentConfig.engineType,
    })
    .from(agentConfig)
    .where(eq(agentConfig.organizationId, organizationId))
    .orderBy(asc(agentConfig.name), asc(agentConfig.id));
}
