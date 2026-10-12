import type { GitRepositoryBindingRow } from "@fenix/git/db";
import { gitRepositoryBindings } from "@fenix/git/db";
import { and, desc, eq } from "drizzle-orm";
import { getGitDatabase } from "../db";

/**
 * 仓库绑定的仓储：只封装持久化与事务原语，不解释授权语义。
 *
 * 归属判断（谁能读、consumer 能否写）在服务层用这里返回的记录做，仓储不做任何「按调用方身份过滤」的
 * 猜测——那需要 actor 与角色知识，而仓储的输入只有调用方给出的键值。本文件同时是 `git_repository_bindings`
 * 的行 → {@link GitBindingRecord} 的唯一转换点：DB 列名与未来加列不向服务层泄漏。
 */

/** 绑定记录的领域投影；字段与调用方实际需要的语义一一对应，不带 DB 列名与时间戳。 */
export interface GitBindingRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly connectionId: string;
  readonly providerRepositoryId: string;
  readonly owner: string;
  readonly name: string;
  /** 日常读写凭据引用（`{env:NAME}`）；解析成凭据值由服务层用宿主注入的密钥表完成。 */
  readonly credentialRef: string;
  /** consumerId → 允许的操作集合；授权判定只看这里的集合，consumerId 来自服务端而非请求正文。 */
  readonly allowedConsumers: Readonly<Record<string, readonly string[]>>;
  /** Webhook 注册结果（T04 写入）；尚未注册为 null。 */
  readonly webhookId: string | null;
  readonly webhookSecretRef: string | null;
  /** active / paused；`paused` 用于运维暂停该仓库的读写后再重新同步。 */
  readonly status: string;
}

/** 写入绑定的输入；`status` 省略时的语义见 {@link gitBindingRepo.upsert}。 */
export interface UpsertGitBindingInput {
  readonly organizationId: string;
  readonly connectionId: string;
  readonly providerRepositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly credentialRef: string;
  readonly allowedConsumers: Readonly<Record<string, readonly string[]>>;
  readonly status?: string;
}

export const gitBindingRepo = {
  /** 按「连接 + 托管平台仓库 ID」读取；这两个字段就是唯一索引，最多一行。 */
  async findByConnectionAndRepository(
    connectionId: string,
    providerRepositoryId: string,
  ): Promise<GitBindingRecord | null> {
    const rows = await getGitDatabase()
      .select()
      .from(gitRepositoryBindings)
      .where(
        and(
          eq(gitRepositoryBindings.connectionId, connectionId),
          eq(gitRepositoryBindings.providerRepositoryId, providerRepositoryId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toBindingRecord(row);
  },

  /** 按绑定 ID 读取；调用方拿到的绑定 ID 是否在它有权访问的组织内，由服务层判断。 */
  async findById(id: string): Promise<GitBindingRecord | null> {
    const rows = await getGitDatabase()
      .select()
      .from(gitRepositoryBindings)
      .where(eq(gitRepositoryBindings.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toBindingRecord(row);
  },

  async listByOrganization(organizationId: string): Promise<GitBindingRecord[]> {
    const rows = await getGitDatabase()
      .select()
      .from(gitRepositoryBindings)
      .where(eq(gitRepositoryBindings.organizationId, organizationId));
    return rows.map(toBindingRecord);
  },

  /**
   * 按「连接 + owner/name」读取。
   *
   * owner/name 不是唯一键：仓库改名后旧坐标可能仍留在历史行上，与新建的同名仓库并存。这里按最近更新
   * 的一行返回（改名会刷新 updatedAt），调用方仍需容忍「同坐标存在多条历史绑定」这一事实。
   */
  async findByOwnerAndName(connectionId: string, owner: string, name: string): Promise<GitBindingRecord | null> {
    const rows = await getGitDatabase()
      .select()
      .from(gitRepositoryBindings)
      .where(
        and(
          eq(gitRepositoryBindings.connectionId, connectionId),
          eq(gitRepositoryBindings.owner, owner),
          eq(gitRepositoryBindings.name, name),
        ),
      )
      .orderBy(desc(gitRepositoryBindings.updatedAt))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toBindingRecord(row);
  },

  /**
   * 注册或刷新绑定：冲突时更新 `credentialRef` / `allowedConsumers`，显式传入的 `status` 才会被改写。
   *
   * 冲突目标就是 `(connection_id, provider_repository_id)` 唯一索引——同一连接下的同一个仓库
   * （providerRepositoryId 稳定）只保留一行绑定，重复绑定等价于刷新授权而不是新增记录。
   *
   * 两处刻意**不更新**：
   * - `organizationId`：绑定不能跨组织迁移。跨组织冲突由服务层在写之前识别并拒绝，这里把租户列钉在
   *   原值上，封掉「检查与写入之间被另一并发写改掉归属」的窗口——那是一条跨租户接管路径。
   * - `status`（未显式传入时）：`paused` 是运维「先暂停写入、再重新同步」的决定，重跑 bootstrap
   *   不应把它悄悄恢复成 `active`；恢复必须显式传 `status: "active"`。
   */
  async upsert(input: UpsertGitBindingInput): Promise<GitBindingRecord> {
    const [row] = await getGitDatabase()
      .insert(gitRepositoryBindings)
      .values({
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        providerRepositoryId: input.providerRepositoryId,
        owner: input.owner,
        name: input.name,
        credentialRef: input.credentialRef,
        allowedConsumers: toWritableConsumers(input.allowedConsumers),
        status: input.status ?? "active",
      })
      .onConflictDoUpdate({
        target: [gitRepositoryBindings.connectionId, gitRepositoryBindings.providerRepositoryId],
        set: {
          credentialRef: input.credentialRef,
          allowedConsumers: toWritableConsumers(input.allowedConsumers),
          ...(input.status === undefined ? {} : { status: input.status }),
          updatedAt: new Date(),
        },
      })
      .returning();
    return toBindingRecord(row);
  },
};

/**
 * jsonb 列的写入形状是 `Record<string, string[]>`，输入刻意声明为只读，这里复制一层完成类型转换。
 * 复制不是防串改：jsonb 在写入时即已序列化，调用方之后修改自己的集合不会影响已写入内容。
 */
function toWritableConsumers(consumers: Readonly<Record<string, readonly string[]>>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(consumers).map(([consumerId, operations]) => [consumerId, [...operations]]));
}

/**
 * 行 → 领域投影。
 *
 * `allowedConsumers` 直接取用行上的 jsonb 对象：列类型已声明为 `Record<string, string[]>`，行对象一次
 * 查询即弃且不再被谁引用，再复制一层只是浪费。
 */
function toBindingRecord(row: GitRepositoryBindingRow): GitBindingRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    connectionId: row.connectionId,
    providerRepositoryId: row.providerRepositoryId,
    owner: row.owner,
    name: row.name,
    credentialRef: row.credentialRef,
    allowedConsumers: row.allowedConsumers,
    webhookId: row.webhookId,
    webhookSecretRef: row.webhookSecretRef,
    status: row.status,
  };
}
