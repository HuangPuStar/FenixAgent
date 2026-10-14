import type { ResourceRegistration } from "@fenix/platform-sdk";
import { ticketProjects } from "@fenix/resource-tickets/db";
import type { PgColumn } from "drizzle-orm/pg-core";

/** 受控资源类型：工单项目（一个组织的一条工单通道）。 */
export const TICKET_PROJECT_RESOURCE_TYPE = "ticket_project";

export const ticketProjectResource = {
  definition: {
    type: TICKET_PROJECT_RESOURCE_TYPE,
    ownershipMode: "organization",
    /** 无 delete：项目只暂停、不删除（方案 §8「暂停组织工单时保留绑定和数据」）。 */
    actions: ["read", "create", "update"],
    /**
     * 成员默认动作只有 read。
     *
     * 方案的「同一组织成员可查看全部工单、创建和评论」**不**由这里表达：工单本体的事实源在 Forgejo，
     * 不是受控资源行；「能读项目 ⟺ 能读写该项目下的工单」由 Facade 的规则固定（§5.3）。把 create 塞进
     * memberDefaultActions 会同时被类型（`Extract<ResourceAction,"read"|"use">`）与 projectActions 拒绝，
     * 而且会让成员获得项目开通能力——那正是方案 §5 要挡的管理动作。
     */
    memberDefaultActions: ["read"],
    /** 无平台级公开受众：工单项目永不跨组织可见（跨组织共享仓库不在本次合同内）。 */
    publicDefaultActions: [],
  },
  storage: {
    resourceType: TICKET_PROJECT_RESOURCE_TYPE,
    table: ticketProjects,
    /**
     * 只声明归属列：`ticket_projects` 没有平台受众列（status 是项目生命周期，不是可见性；语义冲突的
     * 先例与理由见 agent-site-app-resource.ts:12-31）。不声明 visibility 列 ⇒ 范围恒为 private。
     */
    columns: { id: ticketProjects.id, organizationId: ticketProjects.organizationId },
  },
} satisfies ResourceRegistration<typeof ticketProjects, PgColumn>;
