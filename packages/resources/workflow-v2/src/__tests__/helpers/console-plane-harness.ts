// 控制面（`/web/workflow-v2/workflows*`）用例的共享夹具：真实 Postgres 句柄、会话守卫替身、上游替身与
// 审计断言读取。抽出来的理由与包内既有口径一致（`canvas-bff.test.ts` 的注释也说明了这一点）：替身依赖
// Drizzle/Bun 的具体形状，各文件各留一份时容易在「谓词是否真的生效」上产生细微差异。
//
// 本文件不是用例文件（文件名不含 `.test.`），`bun test` 不会把它当作用例收集；它只被同目录的用例导入。

import { initializeTestApplicationInfrastructure, readJson, resetAllStubs } from "@fenix/platform-sdk/testing";
import {
  workflowV2AuditLog,
  workflowV2OrgApp,
  workflowV2PlatformAccount,
  workflowV2Workflow,
} from "@fenix/resource-workflow-v2/db";
import { and, eq, like, notLike } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Elysia } from "elysia";
import { Pool } from "pg";
import type { UpstreamCallInput, UpstreamCallResult } from "../../server/services/upstream-client";
import { registerWorkflow } from "../../server/services/workflow-registry";
import { createTestScopedDatabase as scopePlatformAccountReads } from "./scoped-database";

type Database = ReturnType<typeof drizzle>;

const CONNECTION_STRING = process.env.DATABASE_URL;

/**
 * 连接池与句柄按需建立、关池后置空。
 *
 * 为什么不是模块加载时建一次：本文件被同目录多个用例文件共享（Bun 的测试进程里模块实例是共享的），而每个
 * 文件收尾都会调 `closeTestPool()`——一次性建立的池会被先跑完的那个文件关掉，其后的文件全部撞上
 * 「Cannot use a pool after calling end on the pool」。按需重建让「哪个文件先跑」不再影响结果。
 */
let pool: Pool | null = null;
let handle: Database | null = null;

function ensureHandle(): Database | null {
  if (CONNECTION_STRING === undefined || CONNECTION_STRING.length === 0) return null;
  if (handle === null) {
    pool = new Pool({ connectionString: CONNECTION_STRING, max: 2 });
    handle = drizzle(pool);
  }
  return handle;
}

/**
 * 库是否可达：连不上时整组跳过并打印原因（CI 没有数据库服务，硬失败会让 `bun test packages/` 变成不可用
 * 门禁）；跳过是显式的，不是静默通过。
 */
export const databaseReachable = await (async () => {
  const initial = ensureHandle();
  if (initial === null) return false;
  try {
    await pool?.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
})();

if (!databaseReachable) console.warn("[workflow-v2 控制面用例] 跳过：DATABASE_URL 未配置或本地 Postgres 不可达。");

/** 取真实句柄；跳过组之外的用例不应调用它。 */
export function database(): Database {
  const current = ensureHandle();
  if (current === null) throw new Error("本地 Postgres 不可达，测试数据层未装配");
  return current;
}

/** 收尾：关掉本进程的测试连接池；之后的用例需要时按需重建（见 `ensureHandle`）。 */
export async function closeTestPool(): Promise<void> {
  const current = pool;
  pool = null;
  handle = null;
  await current?.end();
}

/**
 * 复位替身后注入数据库句柄（应用基础设施只允许初始化一次，不复位第二条用例就会抛错）。
 *
 * **默认注入带测试作用域的句柄**（见 {@link createTestScopedDatabase}）：本机主库上可能存在真实台账行，而台账
 * 是全局单行表、读路径按 `created_at` 取全表首行——真实行（或任何非本用例前缀的行）一旦比本用例种下的行更早，
 * 就会顶掉「本组织的账号」：`space_id` 断言、绑定判定与按需引导全部跑偏（实测：一行 epoch 时间的探针行足以让
 * 发布与注册表用例集体失败），反过来用例的引导写入还会改写那一行、再被前缀清理删掉——既污染真实数据，也让
 * 「我的行是最早的一行」成为隐性假设。作用域只影响台账的**读**，其余表与所有写语句原样落库。
 *
 * 需要未加作用域的裸句柄时显式传 `database()`（当前没有这样的用例；引入前请先说明理由）。
 */
export function installDatabase(injected: unknown = createTestScopedDatabase()): void {
  resetAllStubs();
  initializeTestApplicationInfrastructure({ database: injected });
}

const TEST_PREFIX = "wf2-test-";
/** 本次运行的唯一后缀：避免与上一次崩溃残留的行、或并行的另一次运行相互干扰。 */
const RUN = crypto.randomUUID().slice(0, 8);

export const ORG_A = `${TEST_PREFIX}${RUN}-a`;
export const ORG_B = `${TEST_PREFIX}${RUN}-b`;
export const SPACE_ID = `${TEST_PREFIX}${RUN}-space`;
export const APP_ID = `${TEST_PREFIX}${RUN}-app`;
export const OWNER_ID = `${TEST_PREFIX}${RUN}-user`;

/** 测试对象的上游 ID；一律带前缀，清理与断言都按前缀走。 */
export const upstreamId = (suffix: string): string => `${TEST_PREFIX}${RUN}-${suffix}`;

/** 上游成功信封（`code: 0` 是唯一成功判定，见契约快照 §3 F5）。 */
export const upstreamOk = (body: Record<string, unknown>): UpstreamCallResult => ({
  status: 200,
  body: { code: 0, ...body },
});

/** 上游业务失败信封；`msg` 用上游服务端的原文形态，发布拒绝的区分依赖它。 */
export const upstreamFail = (code: number, msg: string): UpstreamCallResult => ({ status: 200, body: { code, msg } });

/** 上游调用替身：记录每次入参、按路径返回预置响应；未注册路径直接失败，避免用例静默打到真实上游。 */
export function createUpstreamStub(responses: Record<string, () => UpstreamCallResult | Promise<UpstreamCallResult>>) {
  const calls: UpstreamCallInput[] = [];
  const call = async (input: UpstreamCallInput): Promise<UpstreamCallResult> => {
    calls.push(input);
    const handler = responses[input.path];
    if (!handler) throw new Error(`测试未注册的上游路径：${input.path}`);
    return handler();
  };
  return { call, calls };
}

/** 某次上游调用的请求体；断言服务端注入值用。 */
export const sentBody = (calls: readonly UpstreamCallInput[], index: number): Record<string, unknown> =>
  (calls[index]?.body ?? {}) as Record<string, unknown>;

/**
 * 会话守卫替身：只提供工厂注册路由所需的 `sessionAuth` 宏与 `store.authContext`；不复制宿主鉴权策略
 * （那条链路由宿主用例覆盖）。
 */
export function createStubAuthGuard() {
  let actor: { organizationId: string; userId: string } | null = null;
  const plugin = new Elysia({ name: "wf2-test-session-auth" })
    .state({ authContext: null as { organizationId: string; userId: string } | null })
    .macro({
      sessionAuth(enabled: boolean) {
        if (!enabled) return {};
        return {
          beforeHandle({ store }: { store: { authContext: { organizationId: string; userId: string } | null } }) {
            if (actor) store.authContext = actor;
          },
        };
      },
    });
  return {
    plugin,
    /** 切换当前请求的 actor；`null` 表示未认证。 */
    setActor(next: { organizationId: string; userId: string } | null) {
      actor = next;
    },
  };
}

/**
 * 写平台账号与租户 App 绑定；`onConflictDoNothing` 让每条用例重复装配保持幂等。
 *
 * `organizationId` / `appId` 可换：运行日志的「无工作流」用例需要一个**已绑定但不含任何记录**的组织，而
 * `ORG_A` 会被同目录多个用例写入（不能复用来断言空目录）；`app_id` 有唯一约束，因此换组织时必须同时换
 * App ID，否则第二行会被 `onConflictDoNothing` 静默跳过、组织仍停留在「未绑定」。
 */
export async function seedBinding(organizationId: string = ORG_A, appId: string = APP_ID): Promise<void> {
  // 平台账号是单行表且读取取 `createdAt` 最早的一行：固定用 epoch 让本文件的行走稳定胜出，因而不必
  // 删除库里可能存在的其它行（那会破坏本机既有数据）。
  await database()
    .insert(workflowV2PlatformAccount)
    .values({
      platformUserId: `${TEST_PREFIX}${RUN}-account`,
      platformSpaceId: SPACE_ID,
      email: "workflow-v2-test@example.invalid",
      status: "active",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    })
    .onConflictDoNothing();
  await database()
    .insert(workflowV2OrgApp)
    .values({ organizationId, appId, name: "测试租户 App", status: "active" })
    .onConflictDoNothing();
}

/** 登记一条记录（不经路由），可选直接置已发布版本，供「版本自增」用例做前置条件。 */
export async function seedRecord(suffix: string, publishedVersion: string | null = null, organizationId = ORG_A) {
  const record = await registerWorkflow({
    organizationId,
    upstreamWorkflowId: upstreamId(suffix),
    appId: APP_ID,
    name: `阶段三 ${suffix}`,
    ownerUserId: OWNER_ID,
    visibility: "private",
  });
  if (publishedVersion !== null) {
    await database().update(workflowV2Workflow).set({ publishedVersion }).where(eq(workflowV2Workflow.id, record.id));
  }
  return record;
}

/** 对被测应用发一次请求。 */
export const request = (app: Elysia, path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost${path}`, init));

/** JSON 请求初始化。 */
export const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** 控制面响应体的最小断言形状（成功与失败两个信封）。 */
export const readBody = async (response: Response) =>
  (await readJson(response)) as {
    success: boolean;
    data?: {
      version?: string;
      commitId?: string;
      id?: string;
      upstreamWorkflowId?: string;
      ok?: boolean;
      /** 发布概况（`GET /workflows/:id/publish-records`）：上游当前发布版本 + 上游发布记录。 */
      current?: { publishedVersion: string | null };
      records?: Array<{
        workflowId: string | null;
        name: string | null;
        publishedAt: string | null;
        ownerId: string | null;
      }>;
      /**
       * 运行日志（`GET /run-records`）：归一化记录 + 筛选选项 + 扫描口径。
       *
       * `items` 与 `routes/web/workflow-runs.ts` 的 `RunRecordSchema` **逐字段对应**（上游缺失的一律 null、
       * 不省略键）：形状漂移时这里的 `toEqual` 断言会直接报类型错，而不是放行一个与契约不符的响应。
       */
      items?: Array<{
        workflowId: string | null;
        workflowName: string | null;
        executeId: string | null;
        logId: string | null;
        version: string | null;
        mode: "debug" | "release" | "node_debug" | null;
        status: "running" | "succeeded" | "failed" | "canceled" | "interrupted" | null;
        durationMs: number | null;
        createdAt: string | null;
        errorCode: string | null;
        nodeCount: number | null;
      }>;
      /** 平台侧运行记录（`PlatformRunSchema`）：平台触发的运行在本地审计流水里的留痕。 */
      platformRuns?: Array<{
        upstreamWorkflowId: string | null;
        occurredAt: string;
        result: string;
        errorCode: string | null;
      }>;
      workflows?: Array<{ id: string; name: string }>;
      scannedWorkflows?: number;
      workflowTotal?: number;
      truncated?: boolean;
      /** 上游可能还有更早的运行（页满推断，见服务层 `WorkflowRunRecords.hasMoreUpstream`）。 */
      hasMoreUpstream?: boolean;
      /**
       * 单次运行的出入参数（`GET /run-records/:executeId/io`，与 `RunIoResponseSchema` 逐字段对应）。
       *
       * 两段都是 JSON 序列化字符串；上游缺对应节点时为 null（服务端不猜、不造默认值）。
       */
      input?: string | null;
      output?: string | null;
    };
    error?: { code: string; message: string };
  };

/** 读原始行（绕过仓储的软删谓词）：断言发布的写回与删除的状态变化。 */
export async function readRawRow(upstreamWorkflowId: string) {
  const [row] = await database()
    .select()
    .from(workflowV2Workflow)
    .where(eq(workflowV2Workflow.upstreamWorkflowId, upstreamWorkflowId))
    .limit(1);
  return row;
}

/** 读某组织某动作的审计流水；断言审计覆盖时只关心这几个字段（不含 body 与上游原文）。 */
export async function readAuditRows(organizationId: string, action: string) {
  return database()
    .select({
      upstreamWorkflowId: workflowV2AuditLog.upstreamWorkflowId,
      result: workflowV2AuditLog.result,
      errorCode: workflowV2AuditLog.errorCode,
      actorUserId: workflowV2AuditLog.actorUserId,
      requestId: workflowV2AuditLog.requestId,
    })
    .from(workflowV2AuditLog)
    .where(and(eq(workflowV2AuditLog.organizationId, organizationId), eq(workflowV2AuditLog.action, action)));
}

/**
 * 只删平台账号台账行（保留租户 App 绑定），复现「台账缺行但绑定还在」这一运维状态。
 *
 * 该状态的成因是台账行的唯一写入点是引导路径，而历史库清理/库重建/迁移演练都会让行丢失（见
 * `platform-account-bootstrap.ts` 的 `ensurePlatformAccountWithinBudget` 文件内说明）；此时列表页照常显示
 * 卡片（它的门只读 `workflow_v2_org_app`），而需要 `space_id` 的接口全部失效。
 */
export async function clearPlatformAccount(): Promise<void> {
  await database()
    .delete(workflowV2PlatformAccount)
    .where(like(workflowV2PlatformAccount.platformUserId, `${TEST_PREFIX}%`));
}

/**
 * 读平台账号台账当前有几行（**只看本用例前缀**）。
 *
 * 只数测试前缀行：台账是全局单行表，`ensurePlatformAccountWithinBudget` 恢复时会按上游登录响应回显的
 * `user_id_str` 写行，因此**假上游的用户 ID 必须带本前缀**（用 {@link upstreamId} 构造），否则恢复出来的行既
 * 躲过 `clearPlatformAccount`、也躲过 `cleanupTestRows`，会污染同库的其它用例。
 */
export async function countPlatformAccounts(): Promise<number> {
  const rows = await database()
    .select({ id: workflowV2PlatformAccount.id })
    .from(workflowV2PlatformAccount)
    .where(like(workflowV2PlatformAccount.platformUserId, `${TEST_PREFIX}%`));
  return rows.length;
}

/** 台账里**非本用例前缀**的行（本机主库上的真实行）：用例用它断言「没碰真实数据」。 */
export async function readForeignPlatformAccounts() {
  return await database()
    .select({
      id: workflowV2PlatformAccount.id,
      platformUserId: workflowV2PlatformAccount.platformUserId,
      status: workflowV2PlatformAccount.status,
      lastError: workflowV2PlatformAccount.lastError,
      updatedAt: workflowV2PlatformAccount.updatedAt,
    })
    .from(workflowV2PlatformAccount)
    .where(notLike(workflowV2PlatformAccount.platformUserId, `${TEST_PREFIX}%`));
}

/**
 * 把「平台账号台账」的**读取**收进本用例前缀的数据库句柄（其余表与语句原样转发）。
 *
 * 实现与完整理由见 `helpers/scoped-database.ts`——本函数只是把本文件的句柄与前缀绑上去。要点：台账是全局单行
 * 表、生产读路径取全表首行，未加作用域的用例会被本机主库上的真实行顶掉归属，甚至把真实行的身份改写后被前缀
 * 清理删掉。**本文件的注入默认走它**（见 {@link installDatabase}），因此本文件所有用例都不再依赖「全表为空」
 * 或「我的行是最早的一行」这类脆弱假设。
 */
export function createTestScopedDatabase(): unknown {
  return scopePlatformAccountReads(database(), TEST_PREFIX);
}

/** 清掉本文件写过的测试数据；只看前缀，绝不触碰既有行。 */
export async function cleanupTestRows(): Promise<void> {
  const pattern = `${TEST_PREFIX}%`;
  await database().delete(workflowV2Workflow).where(like(workflowV2Workflow.upstreamWorkflowId, pattern));
  await database().delete(workflowV2AuditLog).where(like(workflowV2AuditLog.organizationId, pattern));
  await database().delete(workflowV2OrgApp).where(like(workflowV2OrgApp.organizationId, pattern));
  await database().delete(workflowV2PlatformAccount).where(like(workflowV2PlatformAccount.platformUserId, pattern));
}
