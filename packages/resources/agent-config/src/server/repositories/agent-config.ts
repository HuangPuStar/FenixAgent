import { agentConfig } from "@fenix/agent-config/db";
import { and, asc, eq, ilike, inArray, or } from "drizzle-orm";
import { getAgentConfigDatabase } from "../db";

/**
 * Agent 配置的**跨包取数面**：调用期只读投影，以及一处系统写入口（machine 注册时按名称绑定机器）。
 *
 * 本包不向别的包交出资源行：调用方要的是"叫什么、谁拥有、跑在哪"这类投影，给整行会诱使它们自己判归属、
 * 自己解释 `machineId` / `agentNode` 的优先级（§4.8 第 4 条：调用期只能经 owner 的公开 service / DTO
 * 取数）。因此这里的每个函数都只取消费者真正需要的列，注释里写明它服务哪一个调用方。
 *
 * 为什么这几件事同处一个文件：它们的共同点是「不经授权谓词、不是请求路径」的系统取数，而资源行的授权
 * 读写（`AgentConfigRepository`）要求 `ActorContext` 与 `ResourceQueryConstraint`，形状完全不同。按消费者
 * 各开一个文件会让每个文件只剩一个函数，而抽象应延迟到第二个真实用例出现时（CLAUDE.md 核心原则 1）。
 *
 * CE 1.4 W4 已删除本文件原有的「扁平聚合读取」（`PgAgentConfigRepo`，为编排域的扁平 LaunchSpec 供数）：
 * 启动参数组装改由 `services/agent-launch-spec/` 按领域解析，不需要一份把 skills / mcpServers /
 * knowledgeBases 拍平的中间视图。
 */

/**
 * 按配置 ID 批量查询展示名称（Observer 面板与模型网关主体列表的 name(id) 展示用，只读）。
 * 空入参返回空 Map，避免生成空 IN 子句。
 */
export async function findAgentConfigNamesByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const db = getAgentConfigDatabase();
  const rows = await db
    .select({ id: agentConfig.id, name: agentConfig.name })
    .from(agentConfig)
    .where(inArray(agentConfig.id, ids));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** 「谁拥有哪些 Agent、跑在哪」的归属投影；消费方是 Observer 的系统人员树。 */
export interface AgentConfigOwnershipRow {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  machineId: string | null;
  engineType: string | null;
}

/**
 * 按组织列出 Agent 配置归属（Observer 人员树，只读）。
 *
 * 排序在 SQL 内完成（name → id）：消费方会对用户分组再次排序，若这里不确定顺序，同一份数据在不同数据库
 * 执行计划下的输出会不同，断言与界面都会抖动。
 */
export async function listAgentConfigsByOrganization(organizationId: string): Promise<AgentConfigOwnershipRow[]> {
  return getAgentConfigDatabase()
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

/** 全局分页检索的输入（系统管理面：模型网关预算主体选择器）；分页用 limit/offset，协议层的 page/pageSize 由消费方换算。 */
export interface AgentConfigSystemSearchInput {
  keyword?: string;
  organizationId?: string;
  userId?: string;
  limit: number;
  offset: number;
}

/** 系统管理面检索的投影：只有主体选择器渲染与回填需要的四列。 */
export interface AgentConfigSystemSearchRow {
  id: string;
  name: string;
  organizationId: string;
  userId: string;
}

/**
 * 按组织 / 用户 / 关键字在**全局** `agent_config` 上分页检索（只读，无授权谓词）。
 *
 * 该投影服务 `/api/system/model-gateway/*` 这类系统管理面：调用方没有请求主体，因此不走授权查询
 * （授权入口是 `facade`，需要 `access` 条件与 actor）；过滤条件只按列匹配，不复制本包的领域规则。
 *
 * `organization_id` / `user_id` 用 `ilike` 是迁入前的既有行为（无通配符时等价于大小写不敏感等值匹配），
 * 逐字保留以免改变系统管理面的筛选结果。
 */
export async function searchAgentConfigsSystem(
  input: AgentConfigSystemSearchInput,
): Promise<AgentConfigSystemSearchRow[]> {
  const conditions = [];
  if (input.organizationId) conditions.push(ilike(agentConfig.organizationId, input.organizationId));
  if (input.userId) conditions.push(ilike(agentConfig.userId, input.userId));
  if (input.keyword?.trim()) {
    const keyword = `%${input.keyword.trim()}%`;
    conditions.push(or(ilike(agentConfig.name, keyword), ilike(agentConfig.id, keyword)));
  }
  return getAgentConfigDatabase()
    .select({
      id: agentConfig.id,
      name: agentConfig.name,
      organizationId: agentConfig.organizationId,
      userId: agentConfig.userId,
    })
    .from(agentConfig)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .limit(input.limit)
    .offset(input.offset);
}

/**
 * 该组织是否仍有 Agent 配置绑定在这台机器上（machine 删除前的悬空引用守卫，只读）。
 *
 * 只回布尔不回行：machine 只需要一个「还能不能删」的判定，把候选行交给它等于让它自己写业务条件。
 * 判定用 `limit 1` 而不是 `count`——存在性判定不需要全表计数。
 */
export async function isAgentConfigBoundToMachine(organizationId: string, machineId: string): Promise<boolean> {
  const rows = await getAgentConfigDatabase()
    .select({ id: agentConfig.id })
    .from(agentConfig)
    .where(and(eq(agentConfig.organizationId, organizationId), eq(agentConfig.machineId, machineId)))
    .limit(1);
  return rows.length > 0;
}

/** 机器注册路径的绑定输入：按名称匹配本组织的 Agent 配置。 */
export interface BindMachineIdByAgentNameInput {
  organizationId: string;
  agentName: string;
  machineId: string;
}

/**
 * 把机器 ID 写进本组织同名的 Agent 配置行（machine 注册路径的系统写入，无 actor）。
 *
 * 这是本文件唯一的写入口，也是全包唯一对 `machineId` 列的跨包写：机器注册时上报的 `agentName` 是它的
 * 唯一身份线索，匹配与写入都必须落在本包——列语义与"同名多条一起绑定"这条规则都属于 Agent 配置
 * （§4.8 第 7 条：调用期跨包写随表迁出收敛为 owner 的写入口）。`updatedAt` 同步刷新，与资源行写入口径
 * 一致。
 */
export async function bindMachineIdByAgentName(input: BindMachineIdByAgentNameInput): Promise<void> {
  const { organizationId, agentName, machineId } = input;
  await getAgentConfigDatabase()
    .update(agentConfig)
    .set({ machineId, updatedAt: new Date() })
    .where(and(eq(agentConfig.organizationId, organizationId), eq(agentConfig.name, agentName)));
}
