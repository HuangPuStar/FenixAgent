import { eq, inArray } from "drizzle-orm";
import { organization } from "../../db/schema";
import { getIdentityDatabase } from "../db";

/**
 * 组织名录读取。
 *
 * 迁移自 `packages/resources/identity-admin/src/server/repositories/organization.ts`（CE 阶段 2 任务
 * 1.2）。除 DB 来源改为 `getIdentityDatabase()` 外，接口与查询条件原样保留。
 *
 * 授权侧的旧调用方已随 `resource_permission` 权限栈删除；当前唯一消费者是身份目录
 * （`IdentityDirectory.listOrganizationNames`）。接口保持窄形状不变：它是被资源包间接触达的稳定面，
 * 不因为多了一处读取而扩张。
 *
 * DB 句柄只能在方法内取用：`getIdentityDatabase()` 依赖宿主完成应用基础设施初始化，
 * 模块加载期读取会早于宿主装配。
 */

export interface IOrganizationRepo {
  listNamesByIds(ids: string[]): Promise<Map<string, string>>;
}

class PgOrganizationRepo implements IOrganizationRepo {
  async listNamesByIds(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map<string, string>();
    const db = getIdentityDatabase();
    const rows: { id: string; name: string }[] = await db
      .select({ id: organization.id, name: organization.name })
      .from(organization)
      .where(inArray(organization.id, ids));
    return new Map(rows.map((row): [string, string] => [row.id, row.name]));
  }
}

export const organizationRepo: IOrganizationRepo = new PgOrganizationRepo();

/** 组织名录信息；`IdentityDirectory.getOrganization` 的投影来源。 */
export interface OrganizationBasicInfo {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** 组织 `metadata` 中的默认引擎机器引用；未配置或形状不符时为 null。 */
  readonly defaultMachineId: string | null;
}

/**
 * 从组织 metadata 读取默认引擎的机器引用。
 *
 * `metadata` 是自由 JSON，本模块只承认 `defaultEngine.machineId` 这一个稳定字段（前端身份视图的
 * `readDefaultMachineId` 使用同一约定）；其余内容不进入投影，避免 metadata 无差别扩散到各资源包。
 */
function readDefaultMachineId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const machineId = (metadata as { defaultEngine?: { machineId?: unknown } }).defaultEngine?.machineId;
  return typeof machineId === "string" && machineId.length > 0 ? machineId : null;
}

/**
 * 按 ID 读取单个组织的名录信息；不存在时返回 null。
 *
 * 独立于 `organizationRepo`：后者只提供批量名称投影，多带 slug 的详情读取不该把它的窄接口撑大。
 */
export async function findOrganizationBasicInfoById(organizationId: string): Promise<OrganizationBasicInfo | null> {
  const db = getIdentityDatabase();
  const rows = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      metadata: organization.metadata,
    })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, name: row.name, slug: row.slug, defaultMachineId: readDefaultMachineId(row.metadata) };
}
