// 系统级人员管理树：按组织聚合成员与归属智能体，供 Admin 只读展示。
// 取数经平台契约与资源包公开入口，路由与服务都不接触持久化模型。

import { type AgentConfigOwnershipRow, listAgentConfigsByOrganization } from "@fenix/agent-config/server";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";

/** 人员树上的智能体节点：只保留界面展示与分组的列，不把 owner 的归属投影直接交给协议层。 */
export interface SystemPeopleAgent {
  id: string;
  name: string;
  description: string | null;
  machineId: string | null;
  engineType: string | null;
}

export interface SystemPeopleUser {
  id: string;
  name: string;
  email: string;
  phoneNumber: string | null;
  role: string | null;
  agents: SystemPeopleAgent[];
}

export interface SystemPeopleOrganization {
  id: string;
  name: string;
  slug: string;
  users: SystemPeopleUser[];
}

export interface SystemPeopleTreeService {
  listTree(): Promise<SystemPeopleOrganization[]>;
}

/**
 * 把 agent-config 的归属投影转成本包的展示视图。
 *
 * 边界处显式转换：owner 的行类型（含 `userId`，属归属判定用）不进入本包的视图层，
 * 视图只取界面渲染的列，两侧各自演进（§4.8 第 4 条：调用期经 owner 公开入口取数，
 * 但取到的 DTO 不得替代本包的视图模型）。
 */
function toSystemPeopleAgent(row: AgentConfigOwnershipRow): SystemPeopleAgent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    machineId: row.machineId,
    engineType: row.engineType,
  };
}

/**
 * 构建组织 → 用户 → 智能体树。
 *
 * 用户集合取组织成员与智能体 owner 的并集：历史数据即使缺少 member 行，也不会让
 * 该组织中的 agent_config 从系统管理视图中消失；这类用户的 role 为 null，其展示信息
 * 由目录的批量投影补齐（名字/邮箱），手机号按目录契约不进入该投影，补位项为 null。
 *
 * 组织与成员来自身份目录（身份表读取的唯一合法落点），智能体归属经 agent-config 的公开取数面
 * （B7 起本包不再持有 `agent_config` 的 SQL），两者在服务层合并。
 */
export function createSystemPeopleTreeService(): SystemPeopleTreeService {
  return {
    async listTree() {
      const organizations = await getIdentityDirectory().listOrganizationsWithMembers();
      const result: SystemPeopleOrganization[] = [];

      for (const organization of organizations) {
        const agents = await listAgentConfigsByOrganization(organization.id);

        const users = new Map<string, SystemPeopleUser>(
          organization.members.map((member) => [
            member.userId,
            {
              id: member.userId,
              name: member.name,
              email: member.email,
              phoneNumber: member.phoneNumber,
              role: member.role,
              agents: [],
            },
          ]),
        );

        // 缺 member 行的 owner 单独补齐展示信息：一次批量投影，不在循环里逐行查询。
        const missingOwnerIds = [...new Set(agents.map((agent) => agent.userId))].filter((id) => !users.has(id));
        if (missingOwnerIds.length > 0) {
          const owners = await getIdentityDirectory().listUserDisplayInfo(missingOwnerIds);
          for (const ownerId of missingOwnerIds) {
            const info = owners.get(ownerId);
            users.set(ownerId, {
              id: ownerId,
              name: info?.name ?? ownerId,
              email: info?.email ?? "",
              phoneNumber: null,
              role: null,
              agents: [],
            });
          }
        }

        for (const agent of agents) {
          users.get(agent.userId)?.agents.push(toSystemPeopleAgent(agent));
        }

        result.push({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          users: [...users.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
        });
      }

      return result;
    },
  };
}

export const systemPeopleTreeService = createSystemPeopleTreeService();
