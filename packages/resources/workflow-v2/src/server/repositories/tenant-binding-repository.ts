import { workflowV2OrgApp, workflowV2PlatformAccount } from "@fenix/resource-workflow-v2/db";
import { asc, eq } from "drizzle-orm";
import { getWorkflowV2Database } from "./database";
/**
 * 「当前租户 → 上游空间 + 租户 App」的**只读**投影。
 *
 * 存在的理由：注册表的创建/改名/删除都要往上游注入 `space_id`（平台个人空间）与 `project_id`（租户
 * App），这两个值来自 `workflow_v2_platform_account` 与 `workflow_v2_org_app` 两张表，浏览器不可信、
 * 客户端也不可传入（冻结 §6 的注入白名单）。本文件只回答「这两个值当前是什么」，**写侧（建 App、绑定、
 * 重绑、探活）归租户 App 映射任务（2A）**，不在本文件复制一份状态机。
 *
 * 返回快照而不是直接判定「能不能写」：`active` / `degraded` 的业务含义（写接口快速失败）属于调用方
 * 的决策，存储层只如实回传两行当前状态。
 */

/** 租户绑定快照；任一行为空即调用方说的「尚未绑定」。 */
export interface TenantBindingSnapshot {
  /** 平台个人空间 ID；创建 workflow 时注入为 `space_id`。 */
  readonly platformSpaceId: string;
  /** 租户 App ID；创建 workflow 时注入为 `project_id`。 */
  readonly appId: string;
  /** 平台账号状态（`active` / `degraded`）。 */
  readonly platformStatus: string;
  /** 租户 App 绑定状态（`active` / `degraded`）。 */
  readonly appStatus: string;
}

/**
 * 读取租户绑定快照；平台账号行或本组织的 App 行缺失时返回 null。
 *
 * 平台账号是单行表（`platform_user_id` 唯一索引即存储层的「单行」保证），这里仍按创建时间取首行——
 * 不写 `limit(1)` 会让「多行」这一本不该出现的状态静默变成「随便读一行」。
 */
export async function findTenantBinding(organizationId: string): Promise<TenantBindingSnapshot | null> {
  const db = getWorkflowV2Database();
  const [account] = await db
    .select({ platformSpaceId: workflowV2PlatformAccount.platformSpaceId, status: workflowV2PlatformAccount.status })
    .from(workflowV2PlatformAccount)
    .orderBy(asc(workflowV2PlatformAccount.createdAt))
    .limit(1);
  const [app] = await db
    .select({ appId: workflowV2OrgApp.appId, status: workflowV2OrgApp.status })
    .from(workflowV2OrgApp)
    .where(eq(workflowV2OrgApp.organizationId, organizationId))
    .limit(1);
  if (!account || !app) return null;
  return {
    platformSpaceId: account.platformSpaceId,
    appId: app.appId,
    platformStatus: account.status,
    appStatus: app.status,
  };
}

/**
 * 列全部租户 App 绑定（`organization_id` + `app_id`），按组织 ID 有序。
 *
 * 只服务对账任务的孤儿扫描：它要按「上游 project_id → 本地 organization」反查归属，因此需要全部绑定而
 * 不是某一个组织的那一行。**跨组织读**——返回值同样带着 `organizationId`，是对账判定归属的**唯一**依据
 * （除平台账号的 space_id 外，不再有第二个可用的归属来源），调用方不得把它回给任何请求方。
 *
 * 不过滤 `status`：绑定处于 `degraded` 只说明写路径应快速失败，不影响「这个 App 里的对象属于哪个组织」
 * 这一归属事实；对账按归属补写之后，可见性仍由注册表的组织谓词与后续授权判定承担。
 */
export async function listOrgAppBindings(): Promise<readonly { organizationId: string; appId: string }[]> {
  return await getWorkflowV2Database()
    .select({ organizationId: workflowV2OrgApp.organizationId, appId: workflowV2OrgApp.appId })
    .from(workflowV2OrgApp)
    .orderBy(asc(workflowV2OrgApp.organizationId));
}
