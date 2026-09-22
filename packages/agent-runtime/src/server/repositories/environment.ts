import { environment } from "@fenix/agent-runtime/db";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { type AgentRuntimeDatabase, getAgentRuntimeDatabase } from "../db";
import { resolveWorkspacePath } from "../services/workspace-resolver";

/** Environment 持久化记录 */
export interface EnvironmentRecord {
  id: string;
  name: string;
  description: string | null;
  workspacePath: string;
  agentConfigId: string | null;
  secret: string;
  machineName: string | null;
  directory: string | null;
  branch: string | null;
  gitRepoUrl: string | null;
  workerType: string;
  capabilities: Record<string, unknown> | null;
  status: string;
  username: string | null;
  userId: string | null;
  organizationId: string | null;
  autoStart: boolean;
  lastPollAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnvironmentCreateParams {
  id?: string;
  name?: string;
  description?: string;
  workspacePath?: string;
  agentConfigId?: string | null;
  secret?: string;
  userId: string;
  organizationId?: string | null;
  status?: string;
  machineName?: string;
  directory?: string;
  branch?: string;
  gitRepoUrl?: string;
  workerType?: string;
  username?: string;
  capabilities?: Record<string, unknown>;
  autoStart?: boolean;
}

export type EnvironmentUpdateParams = Partial<
  Pick<
    EnvironmentRecord,
    | "status"
    | "lastPollAt"
    | "capabilities"
    | "machineName"
    | "name"
    | "description"
    | "workspacePath"
    | "agentConfigId"
    | "branch"
    | "gitRepoUrl"
    | "autoStart"
  >
>;

/** Environment 仓储接口 — PostgreSQL 持久化 */
export interface IEnvironmentRepo {
  create(params: EnvironmentCreateParams): Promise<EnvironmentRecord>;
  getById(id: string): Promise<EnvironmentRecord | undefined>;
  getBySecret(secret: string): Promise<EnvironmentRecord | undefined>;
  update(id: string, patch: EnvironmentUpdateParams): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  listActive(): Promise<EnvironmentRecord[]>;
  listAll(): Promise<EnvironmentRecord[]>;
  listByUserId(userId: string): Promise<EnvironmentRecord[]>;
  listActiveByUsername(username: string): Promise<EnvironmentRecord[]>;
  listAcpAgents(): Promise<EnvironmentRecord[]>;
  listAcpAgentsByUserId(userId: string): Promise<EnvironmentRecord[]>;
  listByOrganizationId(organizationId: string): Promise<EnvironmentRecord[]>;
  listOnlineAcpAgents(): Promise<EnvironmentRecord[]>;
  findByAgentConfigId(organizationId: string, agentConfigId: string): Promise<EnvironmentRecord | undefined>;
}

function rowToRecord(row: typeof environment.$inferSelect): EnvironmentRecord {
  const computedWorkspace = resolveWorkspacePath(row.organizationId ?? row.userId ?? "", row.userId ?? "", row.id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    workspacePath: computedWorkspace,
    agentConfigId: row.agentConfigId ?? null,
    secret: row.secret,
    machineName: row.machineName,
    directory: computedWorkspace,
    branch: row.branch,
    gitRepoUrl: row.gitRepoUrl,
    workerType: row.workerType,
    capabilities: (row.capabilities as Record<string, unknown>) ?? null,
    status: row.status,
    username: null,
    userId: row.userId,
    organizationId: row.organizationId ?? null,
    autoStart: row.autoStart ?? false,
    lastPollAt: row.lastPollAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

class PgEnvironmentRepo implements IEnvironmentRepo {
  async create(params: EnvironmentCreateParams): Promise<EnvironmentRecord> {
    const db = getAgentRuntimeDatabase();
    const id = params.id ?? `env_${uuid().replace(/-/g, "")}`;
    const now = new Date();
    const name = params.name || `env-${id.slice(4, 12)}`;
    const workspacePath = params.workspacePath ?? params.directory ?? "/tmp";
    const status = params.status || "active";
    const secret = params.secret || `sec_${uuid().replace(/-/g, "")}`;
    const orgId = params.organizationId ?? params.userId;
    await db.insert(environment).values({
      id,
      name,
      description: params.description ?? null,
      workspacePath,
      agentConfigId: params.agentConfigId ?? null,
      secret,
      machineName: params.machineName ?? null,
      branch: params.branch ?? null,
      gitRepoUrl: params.gitRepoUrl ?? null,
      workerType: params.workerType ?? "acp",
      capabilities: params.capabilities ?? null,
      status,
      userId: params.userId,
      organizationId: orgId,
      autoStart: params.autoStart ?? true,
      lastPollAt: now,
    });
    return {
      id,
      name,
      description: params.description ?? null,
      workspacePath,
      agentConfigId: params.agentConfigId ?? null,
      secret,
      machineName: params.machineName ?? null,
      directory: params.directory ?? null,
      branch: params.branch ?? null,
      gitRepoUrl: params.gitRepoUrl ?? null,
      workerType: params.workerType ?? "acp",
      capabilities: params.capabilities ?? null,
      status,
      username: params.username ?? null,
      userId: params.userId,
      organizationId: orgId,
      autoStart: params.autoStart ?? true,
      lastPollAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getById(id: string): Promise<EnvironmentRecord | undefined> {
    const db = getAgentRuntimeDatabase();
    const rows = await db.select().from(environment).where(eq(environment.id, id)).limit(1);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async getBySecret(secret: string): Promise<EnvironmentRecord | undefined> {
    const db = getAgentRuntimeDatabase();
    const rows = await db.select().from(environment).where(eq(environment.secret, secret)).limit(1);
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async update(id: string, patch: EnvironmentUpdateParams): Promise<boolean> {
    const db = getAgentRuntimeDatabase();
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.lastPollAt !== undefined) set.lastPollAt = patch.lastPollAt;
    if (patch.capabilities !== undefined) set.capabilities = patch.capabilities ?? null;
    if (patch.machineName !== undefined) set.machineName = patch.machineName;
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.workspacePath !== undefined) set.workspacePath = patch.workspacePath;
    if (patch.agentConfigId !== undefined) set.agentConfigId = patch.agentConfigId;
    if (patch.branch !== undefined) set.branch = patch.branch;
    if (patch.gitRepoUrl !== undefined) set.gitRepoUrl = patch.gitRepoUrl;
    if (patch.autoStart !== undefined) set.autoStart = patch.autoStart;
    const result = await db.update(environment).set(set).where(eq(environment.id, id));
    return (result as unknown as { count: number }).count > 0;
  }

  async delete(id: string): Promise<boolean> {
    const db = getAgentRuntimeDatabase();
    const result = await db.delete(environment).where(eq(environment.id, id));
    return (result as unknown as { count: number }).count > 0;
  }

  async listActive(): Promise<EnvironmentRecord[]> {
    const db = getAgentRuntimeDatabase();
    const rows = await db.select().from(environment).where(eq(environment.status, "active"));
    return rows.map(rowToRecord);
  }

  async listAll(): Promise<EnvironmentRecord[]> {
    const db = getAgentRuntimeDatabase();
    const rows = await db.select().from(environment);
    return rows.map(rowToRecord);
  }

  async listByUserId(userId: string): Promise<EnvironmentRecord[]> {
    const db = getAgentRuntimeDatabase();
    const rows = await db.select().from(environment).where(eq(environment.userId, userId));
    return rows.map(rowToRecord);
  }

  async listActiveByUsername(username: string): Promise<EnvironmentRecord[]> {
    // 按登录名定位用户：身份表读取唯一经 IdentityDirectory，本仓储不得直接查身份表。
    const userInfo = await getIdentityDirectory().findUserByName(username);
    if (!userInfo) return [];
    const db = getAgentRuntimeDatabase();
    const rows = await db
      .select()
      .from(environment)
      .where(and(eq(environment.status, "active"), eq(environment.userId, userInfo.id)));
    return rows.map(rowToRecord);
  }

  async listAcpAgents(): Promise<EnvironmentRecord[]> {
    const db = getAgentRuntimeDatabase();
    const rows = await db.select().from(environment).where(eq(environment.workerType, "acp"));
    return rows.map(rowToRecord);
  }

  async listAcpAgentsByUserId(userId: string): Promise<EnvironmentRecord[]> {
    const db = getAgentRuntimeDatabase();
    const rows = await db
      .select()
      .from(environment)
      .where(and(eq(environment.workerType, "acp"), eq(environment.userId, userId)));
    return rows.map(rowToRecord);
  }

  async listByOrganizationId(organizationId: string): Promise<EnvironmentRecord[]> {
    const db = getAgentRuntimeDatabase();
    const rows = await db.select().from(environment).where(eq(environment.organizationId, organizationId));
    return rows.map(rowToRecord);
  }

  async listOnlineAcpAgents(): Promise<EnvironmentRecord[]> {
    const db = getAgentRuntimeDatabase();
    const rows = await db
      .select()
      .from(environment)
      .where(and(eq(environment.workerType, "acp"), eq(environment.status, "active")));
    return rows.map(rowToRecord);
  }

  async findByAgentConfigId(organizationId: string, agentConfigId: string): Promise<EnvironmentRecord | undefined> {
    const db = getAgentRuntimeDatabase();
    const rows = await db
      .select()
      .from(environment)
      .where(and(eq(environment.organizationId, organizationId), eq(environment.agentConfigId, agentConfigId)))
      .limit(1);
    return rows.length > 0 ? rowToRecord(rows[0]) : undefined;
  }
}

/** 环境仓储的真实实现，也是 `environmentRepo` 未登记替身时的兜底目标。 */
const environmentRepoImpl: IEnvironmentRepo = new PgEnvironmentRepo();

/**
 * 用例登记的仓储替身（**部分覆盖**）：只替换传进来的方法，未登记的方法仍走真实实现。
 *
 * 为什么替身层在本包、而不是继续留在宿主 preload（§1.7 收尾）：宿主原先按本模块的路径 `mock.module`
 * 一份转发 Proxy，包内用例因此只能经宿主测试基建（`@server/test-utils/stubs/module-stubs`）登记替身 ——
 * 这批引用是 `apps-boundary` 台账最后一条（`@fenix/agent-runtime → @fenix/server-app`）的残留面，而
 * 删除条件是「测试侧归零」。替身层随仓储定义一起归本包后，包内用例从 `./server/testing` 取
 * `stubEnvironmentRepo`，语义与替换点都在本包手里。
 *
 * 为什么**必须**同时删掉宿主 preload 的同路径 `mock.module`：preload 注册的 mock 优先级高于包内后注册的
 * mock（Bun 1.3.13 实测，见 review/task-1.7 收尾记录），留着会让包内登记的替身永不生效 —— workflow 的
 * `pg-storage-adapter` 曾在同一形态上踩过（包内断言全部落空）。
 *
 * 为什么未登记时回退真实实现而不是旧的 `{ getById: async () => null }`：那条兜底是「preload 按模块路径
 * 整份替换」的产物（未登记即整份空替身）；改为**部分覆盖**后，未登记的方法保持真实行为，漏登记由用例断言
 * 暴露，而不是被静默吞成空返回值。各用例原本就登记了它依赖的方法（此前的空替身只覆盖 `getById`）。
 */
// biome-ignore lint/suspicious/noExplicitAny: 替身按用例需要只给部分方法，形状由各用例自行收窄
type EnvironmentRepoStub = Record<string, any>;
let environmentRepoStub: EnvironmentRepoStub | null = null;

/** 登记仓储替身（浅合并，同一用例可分多次登记不同方法）。 */
export function setEnvironmentRepoStub(overrides: EnvironmentRepoStub): void {
  environmentRepoStub = { ...(environmentRepoStub ?? {}), ...overrides };
}

/** 清空替身层，供 `resetAllStubs()` 与用例收尾调用。 */
export function resetEnvironmentRepoStubForTest(): void {
  environmentRepoStub = null;
}

/**
 * 环境仓储单例。
 *
 * 为什么用 Proxy 而不是「激活后换绑」：具名导入在模块首次求值时固化绑定，任何「让导出指向另一个对象」的
 * 写法都要么依赖 ESM 实时绑定语义、要么给每个消费方加一层取值函数；Proxy 把每次属性访问转发到当前替身，
 * 与宿主 preload 旧 mock 同形（那段注释记的正是「getter 缓存对象引用会让后置替身永不生效」的 404 事故）。
 *
 * 实现类不使用 `this`（方法体一律直读 `getAgentRuntimeDatabase()`），因此转发不改变方法内的接收者语义；
 * 若将来引入实例状态，需改为显式绑定转发。
 */
export const environmentRepo: IEnvironmentRepo = new Proxy(environmentRepoImpl, {
  get: (target, prop) => {
    if (environmentRepoStub && prop in environmentRepoStub) return environmentRepoStub[prop as string];
    return Reflect.get(target, prop, target);
  },
});

/**
 * 按 Agent 配置取绑定 Environment 的 id 列表（跨包**只读**入口，消费方是 `@fenix/agent-config` 的删除与
 * 重启编排）。
 *
 * **无授权判定**：调用方（`AgentConfigFacade`）已完成资源可见性与 `delete` / `use` 动作判定，本函数只回答
 * 「这条 Agent 配置在其组织下绑了哪些环境」，与迁移前 agent-config 直读 `environment` 表的同口径。
 * 只取 id：调用方把这些 id 交给运行时的连接关闭与实例停止入口，不需要环境行本身。
 */
export async function listEnvironmentIdsByAgentConfig(input: {
  organizationId: string;
  agentConfigId: string;
}): Promise<string[]> {
  const rows = await getAgentRuntimeDatabase()
    .select({ id: environment.id })
    .from(environment)
    .where(
      and(eq(environment.organizationId, input.organizationId), eq(environment.agentConfigId, input.agentConfigId)),
    );
  return rows.map((row) => row.id);
}

/**
 * 在**调用方的事务**内删除某 Agent 配置绑定的 Environment 行（跨包**写**入口）。
 *
 * 为什么接收集合句柄而不是自己开事务：agent-config 的删除路径要在同一事务里完成「删环境 + 删配置」，
 * 拆成两次独立事务会让「配置已删、环境还在」（界面残留无主环境）或「环境已删、配置还在」（workspace 路径与
 * `secret` 已丢、Agent 却仍存在）成为可见中间态。调用方把自己的事务句柄传进来，语义与迁移前它在自己
 * 事务里 `tx.delete(environment)` 完全一致；两个包的句柄类型同为 `NodePgDatabase<Record<string, never>>`
 * （见 `src/server/db.ts` 的类型说明），因此无需跨包共享自定义类型。
 *
 * 只删环境行，删除顺序由调用方决定；`agent_instance` 经 `environment_id` 的 `onDelete: "cascade"` 随之清理。
 * 归属条件同时收 `organization_id` 与 `agent_config_id`：本入口不做授权（调用方 Facade 已判 `delete`），
 * 双条件让「组织与配置配错」的调用退化成空操作，而不是一次跨组织的删除。
 */
export async function deleteEnvironmentsByAgentConfig(
  database: AgentRuntimeDatabase,
  input: { organizationId: string; agentConfigId: string },
): Promise<void> {
  await database
    .delete(environment)
    .where(
      and(eq(environment.organizationId, input.organizationId), eq(environment.agentConfigId, input.agentConfigId)),
    );
}
