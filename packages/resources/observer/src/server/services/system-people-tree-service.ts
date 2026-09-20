// 系统级人员管理树：按组织聚合成员与归属智能体，供 Admin 只读展示。
// 查询显式在服务层完成，避免路由直接接触持久化模型。

import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { listAgentConfigsByOrganization } from "../repositories/system-people-repository";

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
 * 构建组织 → 用户 → 智能体树。
 *
 * 用户集合取组织成员与智能体 owner 的并集：历史数据即使缺少 member 行，也不会让
 * 该组织中的 agent_config 从系统管理视图中消失；这类用户的 role 为 null，其展示信息
 * 由目录的批量投影补齐（名字/邮箱），手机号按目录契约不进入该投影，补位项为 null。
 *
 * 组织与成员来自身份目录（身份表读取的唯一合法落点），智能体归属由本包读取，两者在服务层合并。
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
          users.get(agent.userId)?.agents.push({
            id: agent.id,
            name: agent.name,
            description: agent.description,
            machineId: agent.machineId,
            engineType: agent.engineType,
          });
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
