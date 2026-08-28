// 系统级人员管理树：按组织聚合成员与归属智能体，供 Admin 只读展示。
// 查询显式在服务层完成，避免路由直接接触持久化模型。

import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { agentConfig, member, organization, user } from "../db/schema";

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
 * 该组织中的 agent_config 从系统管理视图中消失；这类用户的 role 为 null。
 */
export function createSystemPeopleTreeService(): SystemPeopleTreeService {
  return {
    async listTree() {
      const organizations = await db.select().from(organization).orderBy(asc(organization.name), asc(organization.id));
      const result: SystemPeopleOrganization[] = [];

      for (const org of organizations) {
        const [members, agents] = await Promise.all([
          db
            .select({
              id: user.id,
              name: user.name,
              email: user.email,
              phoneNumber: user.phoneNumber,
              role: member.role,
            })
            .from(member)
            .innerJoin(user, eq(member.userId, user.id))
            .where(eq(member.organizationId, org.id))
            .orderBy(asc(user.name), asc(user.id)),
          db
            .select({
              id: agentConfig.id,
              userId: agentConfig.userId,
              name: agentConfig.name,
              description: agentConfig.description,
              machineId: agentConfig.machineId,
              engineType: agentConfig.engineType,
              userName: user.name,
              userEmail: user.email,
              userPhoneNumber: user.phoneNumber,
            })
            .from(agentConfig)
            .innerJoin(user, eq(agentConfig.userId, user.id))
            .where(and(eq(agentConfig.organizationId, org.id)))
            .orderBy(asc(user.name), asc(user.id), asc(agentConfig.name), asc(agentConfig.id)),
        ]);

        const users = new Map<string, SystemPeopleUser>(
          members.map((item) => [
            item.id,
            {
              id: item.id,
              name: item.name,
              email: item.email,
              phoneNumber: item.phoneNumber,
              role: item.role,
              agents: [],
            },
          ]),
        );
        for (const agent of agents) {
          const current = users.get(agent.userId);
          const target = current ?? {
            id: agent.userId,
            name: agent.userName,
            email: agent.userEmail,
            phoneNumber: agent.userPhoneNumber,
            role: null,
            agents: [],
          };
          target.agents.push({
            id: agent.id,
            name: agent.name,
            description: agent.description,
            machineId: agent.machineId,
            engineType: agent.engineType,
          });
          users.set(agent.userId, target);
        }

        result.push({
          id: org.id,
          name: org.name,
          slug: org.slug,
          users: [...users.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
        });
      }

      return result;
    },
  };
}

export const systemPeopleTreeService = createSystemPeopleTreeService();
