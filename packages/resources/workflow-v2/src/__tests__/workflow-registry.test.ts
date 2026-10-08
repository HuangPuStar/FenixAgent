// Workflow V2 本地注册表与控制台面：本模块存在的理由就是**多租户隔离的权威**——上游只校验「平台账号
// 属于该 space」，不校验 workflow ↔ App 归属，creator 永远是同一个平台账号。因此本文件把「组织谓词真的
// 进了每条读写路径」当作一等断言，而不是顺带覆盖。
//
// 用例直连本地 Postgres（`DATABASE_URL`，Bun 自动加载 `.env`）：谓词、唯一索引与软删可见性只有真实数据库
// 才作数。连不上库时整组跳过并打印原因（CI 没有数据库服务，硬失败会让 `bun test packages/` 变成不可用
// 门禁）；跳过是显式的，不是静默通过。测试数据一律带 `wf2-test-<run>-` 前缀并自清理。

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { initializeTestApplicationInfrastructure, readJson, resetAllStubs } from "@fenix/platform-sdk/testing";
import {
  workflowV2AuditLog,
  workflowV2OrgApp,
  workflowV2PlatformAccount,
  workflowV2Workflow,
} from "@fenix/resource-workflow-v2/db";
import { and, eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Elysia } from "elysia";
import { Pool } from "pg";
import { createWebWorkflowV2WorkflowRoutes, type WorkflowV2UpstreamCall } from "../server/routes/web/workflows";
import type { UpstreamCallInput, UpstreamCallResult } from "../server/services/upstream-client";
import {
  findWorkflowByUpstreamId,
  listWorkflows,
  registerWorkflow,
  renameWorkflow,
  softDeleteWorkflow,
  WorkflowNotFoundError,
  WorkflowRegistrationConflictError,
  WorkflowRegistrationFailedError,
} from "../server/services/workflow-registry";

// ── 数据库装配 ──

type Database = ReturnType<typeof drizzle>;
type Registration = Parameters<typeof registerWorkflow>[0];

const CONNECTION_STRING = process.env.DATABASE_URL;
const pool = CONNECTION_STRING ? new Pool({ connectionString: CONNECTION_STRING, max: 2 }) : null;
const handle: Database | null = pool ? drizzle(pool) : null;
// 库不可达（CI 无服务、本地没起 docker）时整组跳过；只报告事实，不回显连接串（其中含凭据）。
const databaseReachable =
  (await pool
    ?.query("SELECT 1")
    .then(() => handle !== null)
    .catch(() => false)) ?? false;
if (!databaseReachable) console.warn("[workflow-registry.test] 跳过：DATABASE_URL 未配置或本地 Postgres 不可达。");

/** 取真实句柄；跳过组之外的用例不应调用它。 */
function database(): Database {
  if (!handle) throw new Error("本地 Postgres 不可达，测试数据层未装配");
  return handle;
}

/** 装配句柄：`resetAllStubs` 必须在前——应用基础设施只允许初始化一次，不复位第二条用例就会抛错。 */
function installDatabase(injected: unknown): void {
  resetAllStubs();
  initializeTestApplicationInfrastructure({ database: injected });
}

// ── 测试数据 ──

const TEST_PREFIX = "wf2-test-";
/** 本次运行的唯一后缀：避免与上一次崩溃残留的行、或并行的另一次运行相互干扰。 */
const RUN = crypto.randomUUID().slice(0, 8);
const ORG_A = `${TEST_PREFIX}${RUN}-a`;
const ORG_B = `${TEST_PREFIX}${RUN}-b`;
const SPACE_ID = `${TEST_PREFIX}${RUN}-space`;
const APP_ID = `${TEST_PREFIX}${RUN}-app`;
const OWNER_ID = `${TEST_PREFIX}${RUN}-user`;
const upstreamId = (suffix: string): string => `${TEST_PREFIX}${RUN}-${suffix}`;

/** 登记入参的最简构造；默认落在 A 组织。 */
function registerInput(suffix: string, overrides: Partial<Registration> = {}): Omit<Registration, "id"> {
  return {
    organizationId: ORG_A,
    upstreamWorkflowId: upstreamId(suffix),
    appId: APP_ID,
    name: `工作流 ${suffix}`,
    ownerUserId: OWNER_ID,
    visibility: "private",
    ...overrides,
  };
}

/** 读原始行（绕过仓储的软删谓词）：软删用例要断言「行还在，只是不可见」。 */
async function readRawRow(upstreamWorkflowId: string) {
  const [row] = await database()
    .select()
    .from(workflowV2Workflow)
    .where(eq(workflowV2Workflow.upstreamWorkflowId, upstreamWorkflowId))
    .limit(1);
  return row;
}

/** 清掉本文件写过的测试数据；只看前缀，绝不触碰既有行。 */
async function cleanupTestRows(): Promise<void> {
  const pattern = `${TEST_PREFIX}%`;
  await database().delete(workflowV2Workflow).where(like(workflowV2Workflow.upstreamWorkflowId, pattern));
  await database().delete(workflowV2AuditLog).where(like(workflowV2AuditLog.organizationId, pattern));
  await database().delete(workflowV2OrgApp).where(like(workflowV2OrgApp.organizationId, pattern));
  await database().delete(workflowV2PlatformAccount).where(like(workflowV2PlatformAccount.platformUserId, pattern));
}

// ── 故障注入 ──

/**
 * 故障注入句柄：只改指定行为，其余语句照常打到真实数据库。
 *
 * 创建补偿与「唯一索引冲突」两条路径必须落在真实库上：前者要求「插入真的失败」而审计标记仍然落库，
 * 后者要求「前置查询看不到占用行、插入真的撞上唯一索引」。伪造这两件事，断言的就只是替身自己。
 */
function createFaultyHandle(faults: {
  /** 前 N 次 `select` 返回空集（模拟读快照看不到占用行）。 */
  readonly missingSelects?: number;
  /** workflow 表的插入抛错（模拟落库失败）。 */
  readonly failWorkflowInsert?: boolean;
}): unknown {
  let selectCount = 0;
  /** 空结果集查询链；`then` 让链本身可 await（与真实构建器的可等待性一致）。 */
  const emptySelect = (): unknown => {
    const rows = Promise.resolve([] as unknown[]);
    const chain: Record<string, unknown> = {
      from: () => chain,
      where: () => chain,
      limit: () => rows,
      // 有意实现 thenable：真实查询链不带 `.limit()` 也能被 await（仓储有 `await db.select()...where(...)` 的用法），
      // 替身必须保持同一可等待性，否则会漏测「忘记 limit 时到底是拿一行还是拿数组」这类差异。
      // biome-ignore lint/suspicious/noThenProperty: 该规则针对的是无意中产生的 thenable，此处是刻意的替身行为。
      then: (resolve: (value: unknown) => unknown) => rows.then(resolve),
    };
    return chain;
  };
  return new Proxy(database(), {
    get(target, property) {
      if (property === "select" && faults.missingSelects !== undefined && selectCount < faults.missingSelects) {
        selectCount += 1;
        return emptySelect;
      }
      if (property === "insert" && faults.failWorkflowInsert) {
        return (table: unknown) => {
          if (table === workflowV2Workflow) throw new Error("注入的插入故障");
          return (target as { insert: (value: unknown) => unknown }).insert(table);
        };
      }
      return Reflect.get(target, property, target); // 用 target 作 receiver：句柄方法不依赖 proxy 身份。
    },
  });
}

// ── 上游与守卫替身 ──

/** 上游成功信封（`code: 0` 是唯一成功判定，见契约快照 §3 F5）。 */
const upstreamOk = (body: Record<string, unknown>): UpstreamCallResult => ({ status: 200, body: { code: 0, ...body } });

/** 上游调用替身：记录每次入参、按路径返回预置响应；未注册路径直接失败，避免用例静默打到真实上游。 */
function createUpstreamStub(responses: Record<string, () => UpstreamCallResult>) {
  const calls: UpstreamCallInput[] = [];
  const call: WorkflowV2UpstreamCall = async (input) => {
    calls.push(input);
    const handler = responses[input.path];
    if (!handler) throw new Error(`测试未注册的上游路径：${input.path}`);
    return handler();
  };
  return { call, calls };
}

/** 某次上游调用的请求体；断言服务端注入值用。 */
const sentBody = (calls: readonly UpstreamCallInput[], index: number): Record<string, unknown> =>
  (calls[index]?.body ?? {}) as Record<string, unknown>;

/**
 * 会话守卫替身：只提供工厂注册路由所需的 `sessionAuth` 宏与 `store.authContext`；不复制宿主鉴权策略
 * （那条链路由宿主用例覆盖）。
 */
function createStubAuthGuard() {
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

// ── 生命周期 ──

beforeAll(async () => {
  if (!databaseReachable) return;
  // 残留清理放在头部：上一次运行中途崩溃会留下前缀行，清掉它们才不会让按前缀的断言串味。
  installDatabase(database());
  await cleanupTestRows();
});

afterAll(async () => {
  if (!databaseReachable) return;
  installDatabase(database());
  await cleanupTestRows();
  await pool?.end();
});

describe.skipIf(!databaseReachable)("workflow-v2 本地注册表（真实 Postgres）", () => {
  beforeEach(() => {
    installDatabase(database());
  });

  // 注册成功后可按「组织 + 上游 workflow ID」查回（字段与入参一致），且同一身份重复登记幂等返回同一条
  // ——创建重放、上游重试回调都会走到这条路径，抛唯一索引错误或插入第二行都是错的。
  test("注册后可按组织查回，重复登记幂等返回同一条", async () => {
    const input = registerInput("register");
    const created = await registerWorkflow(input);

    const found = await findWorkflowByUpstreamId(ORG_A, input.upstreamWorkflowId);

    expect(found?.id).toBe(created.id);
    expect(found?.organizationId).toBe(ORG_A);
    expect(found?.appId).toBe(APP_ID);
    expect(found?.name).toBe(input.name);
    expect(found?.ownerUserId).toBe(OWNER_ID);
    expect(found?.visibility).toBe("private");
    expect(found?.publishedVersion).toBeNull();
    expect(found?.syncState).toBe("active");

    expect((await registerWorkflow(input)).id).toBe(created.id);
    const rows = await database()
      .select()
      .from(workflowV2Workflow)
      .where(eq(workflowV2Workflow.upstreamWorkflowId, input.upstreamWorkflowId));
    expect(rows).toHaveLength(1);
  });

  // 跨租户一律当作不存在：单查、列表、重命名、软删四条路径都必须返回「无」，不能只挡其中一条。
  test("A 组织的记录对 B 组织完全不可见", async () => {
    const input = registerInput("isolation");
    const created = await registerWorkflow(input);

    expect(await findWorkflowByUpstreamId(ORG_B, input.upstreamWorkflowId)).toBeNull();
    // 断言「不含这条」而不是「列表为空」：本文件的多条用例复用同一组织，空集断言会随用例顺序漂移。
    expect((await listWorkflows(ORG_B, { page: 1, size: 50 })).items.map((item) => item.id)).not.toContain(created.id);
    expect(await renameWorkflow(ORG_B, created.id, "越权改名")).toBeNull();
    await expect(softDeleteWorkflow(ORG_B, input.upstreamWorkflowId)).rejects.toThrow(WorkflowNotFoundError);

    // 越权尝试不得改动对方行：名字与软删状态都要保持原样。
    const row = await readRawRow(input.upstreamWorkflowId);
    expect(row?.name).toBe(input.name);
    expect(row?.syncState).toBe("active");
    expect(row?.deletedAt).toBeNull();
  });

  // 身份已被别的组织持有时拒绝登记，且**不得回显占用方任何字段**（否则跨租户存在性变成探测面）。
  test("跨组织重复注册抛领域冲突错误且不泄漏占用方字段", async () => {
    const input = registerInput("cross-org");
    await registerWorkflow(input);

    const attempt = registerWorkflow({ ...input, organizationId: ORG_B, name: "B 组织的同名登记" });

    await expect(attempt).rejects.toThrow(WorkflowRegistrationConflictError);
    await attempt.catch((error: unknown) => {
      expect((error as WorkflowRegistrationConflictError).reason).toBe("other_organization");
      expect((error as Error).message).not.toContain(input.name);
      expect((error as Error).message).not.toContain(OWNER_ID);
    });
  });

  // 并发登记：前置查询读不到占用行、插入真的撞上唯一索引时，必须归因为领域冲突错误而非原始 DB 错误；
  // 归因查询能读到占用行时 reason 要落到「被别的组织持有」，日志才能指认冲突来源。
  test("并发登记撞唯一索引时抛领域冲突错误并归因", async () => {
    const input = registerInput("race");
    await registerWorkflow(input);

    // 两次读都被置空（前置查询 + 归因查询），插入走真实连接：真实撞索引但读不到占用者 → concurrent。
    installDatabase(createFaultyHandle({ missingSelects: 2 }));
    const unattributed = registerWorkflow({ ...input, name: "并发登记" });
    await expect(unattributed).rejects.toThrow(WorkflowRegistrationConflictError);
    await unattributed.catch((error: unknown) => {
      expect((error as WorkflowRegistrationConflictError).reason).toBe("concurrent");
      expect((error as Error).message).not.toContain("duplicate key");
    });

    // 只置空前置查询：归因查询读到 A 组织的占用行 → 冲突来自「身份已被别的组织持有」。
    installDatabase(createFaultyHandle({ missingSelects: 1 }));
    const attributed = registerWorkflow({ ...input, organizationId: ORG_B });
    await expect(attributed).rejects.toThrow(WorkflowRegistrationConflictError);
    await attributed.catch((error: unknown) => {
      expect((error as WorkflowRegistrationConflictError).reason).toBe("other_organization");
    });
  });

  // 落库失败（非唯一冲突）时必须写「待清理」审计标记并抛补偿错误：上游刚建的对象要靠它被对账任务删掉。
  test("落库失败时写 pending_cleanup 标记并抛补偿错误", async () => {
    const input = registerInput("compensation");
    installDatabase(createFaultyHandle({ failWorkflowInsert: true }));

    const attempt = registerWorkflow(input);

    await expect(attempt).rejects.toThrow(WorkflowRegistrationFailedError);
    await attempt.catch((error: unknown) => {
      expect((error as WorkflowRegistrationFailedError).cleanupMarkerRecorded).toBe(true);
    });
    // 标记落在真实库上：换回正常句柄后按「组织 + 动作」能捞到，对账任务（4A）才有输入。
    installDatabase(database());
    const markers = await database()
      .select()
      .from(workflowV2AuditLog)
      .where(
        and(
          eq(workflowV2AuditLog.organizationId, ORG_A),
          eq(workflowV2AuditLog.action, "workflow.create.compensation"),
        ),
      );
    expect(markers.map((row) => row.result)).toEqual(["pending_cleanup"]);
    expect(markers[0]?.upstreamWorkflowId).toBe(input.upstreamWorkflowId);
  });

  // 软删是「不可见但行保留」：列表与单查都不再命中，行仍在库并标成 pending_delete 供对账重试上游删除；
  // 软删后再改名必须落空，否则已删行会被改回可见状态。
  test("软删后不可见但行保留为 pending_delete", async () => {
    const input = registerInput("soft-delete");
    const created = await registerWorkflow(input);
    expect((await renameWorkflow(ORG_A, created.id, "新名字"))?.name).toBe("新名字");

    await softDeleteWorkflow(ORG_A, input.upstreamWorkflowId);

    expect(await findWorkflowByUpstreamId(ORG_A, input.upstreamWorkflowId)).toBeNull();
    expect((await listWorkflows(ORG_A, { page: 1, size: 50 })).items.map((item) => item.id)).not.toContain(created.id);
    expect(await renameWorkflow(ORG_A, created.id, "删除后改名")).toBeNull();
    const row = await readRawRow(input.upstreamWorkflowId);
    expect(row?.name).toBe("新名字");
    expect(row?.syncState).toBe("pending_delete");
    expect(row?.deletedAt).not.toBeNull();
    // 重复软删不得静默成功（静默成功会被上层当成「删掉了别人的行」）。
    await expect(softDeleteWorkflow(ORG_A, input.upstreamWorkflowId)).rejects.toThrow(WorkflowNotFoundError);
  });

  // 列表是「本组织 + 未软删」的固定谓词：跨组织行与软删行都不计入，名称过滤与 total 用同一条件。
  test("列表按组织隔离、名称过滤并对齐 total", async () => {
    const keep = registerInput("list-keep", { name: "对账任务" });
    const removable = registerInput("list-removed", { name: "对账任务（已删）" });
    await registerWorkflow(keep);
    await registerWorkflow(registerInput("list-other", { name: "对账任务（B 组织）", organizationId: ORG_B }));
    await registerWorkflow(removable);
    await softDeleteWorkflow(ORG_A, removable.upstreamWorkflowId);

    const page = await listWorkflows(ORG_A, { page: 1, size: 50, name: "对账" });
    const unmatched = await listWorkflows(ORG_A, { page: 1, size: 50, name: "不存在的名字" });

    expect(page.items.map((item) => item.upstreamWorkflowId)).toEqual([keep.upstreamWorkflowId]);
    expect(page.total).toBe(1);
    expect(new Date(page.items[0]?.updatedAt ?? 0).getTime()).toBeGreaterThan(0);
    expect(unmatched.total).toBe(0);
  });
});

describe.skipIf(!databaseReachable)("workflow-v2 /web/workflows 控制台面（真实 Postgres + 上游替身）", () => {
  const ORG_ROUTE = `${TEST_PREFIX}${RUN}-route`;
  const ROUTE_APP_ID = `${TEST_PREFIX}${RUN}-route-app`;
  const guard = createStubAuthGuard();

  let responses: Record<string, () => UpstreamCallResult>;
  let upstream: ReturnType<typeof createUpstreamStub>;
  let app: ReturnType<typeof createWebWorkflowV2WorkflowRoutes>;

  /** 登记一条直接落库的记录（不经路由），供列表/删除/改名的前置条件使用。 */
  const seedRecord = (suffix: string, organizationId = ORG_ROUTE) =>
    registerWorkflow({
      organizationId,
      upstreamWorkflowId: upstreamId(suffix),
      appId: ROUTE_APP_ID,
      name: `控制台 ${suffix}`,
      ownerUserId: OWNER_ID,
      visibility: "private",
    });

  /** 写平台账号与租户 App 绑定；`onConflictDoNothing` 让每条用例重复装配保持幂等。 */
  const seedBinding = async (): Promise<void> => {
    // 平台账号是单行表且读取取 `createdAt` 最早的一行：固定用 epoch 让本文件的行稳定胜出，因而不必
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
      .values({ organizationId: ORG_ROUTE, appId: ROUTE_APP_ID, name: "测试租户 App", status: "active" })
      .onConflictDoNothing();
  };

  const request = (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));
  const jsonInit = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  /** 路由响应体的最小断言形状；`readJson` 按运行时 JSON 值返回，这里只收窄形状、不做协议校验。 */
  const readBody = async (response: Response) =>
    (await readJson(response)) as {
      success: boolean;
      data?: {
        id?: string;
        upstreamWorkflowId?: string;
        deleted?: boolean;
        strategy?: number | null;
        ok?: boolean;
        items?: { id: string; upstreamWorkflowId: string }[];
      };
      error?: { code: string };
    };

  beforeEach(async () => {
    installDatabase(database());
    await seedBinding();
    responses = {};
    upstream = createUpstreamStub(responses);
    app = createWebWorkflowV2WorkflowRoutes({ authGuardPlugin: guard.plugin }, { callUpstream: upstream.call });
    guard.setActor({ organizationId: ORG_ROUTE, userId: OWNER_ID });
  });

  afterAll(() => {
    guard.setActor(null);
  });

  // 创建必须「先上游后本地」并注入服务端身份：space_id 取平台账号、project_id 取本组织 App，
  // 客户端提交的同名字段一律不参与绑定（冻结 §6 的注入白名单）。
  test("创建注入 space_id/project_id 并登记本地记录", async () => {
    responses["/api/workflow_api/create"] = () => upstreamOk({ data: { workflow_id: upstreamId("route-created") } });

    const response = await request(
      "/workflows",
      jsonInit("POST", { name: "控制台新建", space_id: "客户端伪造", project_id: "客户端伪造" }),
    );
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(body.data?.upstreamWorkflowId).toBe(upstreamId("route-created"));
    expect(sentBody(upstream.calls, 0).space_id).toBe(SPACE_ID);
    expect(sentBody(upstream.calls, 0).project_id).toBe(ROUTE_APP_ID);
    expect(sentBody(upstream.calls, 0).name).toBe("控制台新建");
    expect(await findWorkflowByUpstreamId(ORG_ROUTE, upstreamId("route-created"))).not.toBeNull();
  });

  // 本地登记失败时不得留下孤儿：补偿删除刚创建的上游对象，并向调用方返回失败信封。
  test("本地登记失败时补偿删除上游对象并返回失败", async () => {
    const orphanId = upstreamId("route-orphan");
    responses["/api/workflow_api/create"] = () => upstreamOk({ data: { workflow_id: orphanId } });
    responses["/api/workflow_api/delete"] = () => upstreamOk({ data: { status: 0 } });
    installDatabase(createFaultyHandle({ failWorkflowInsert: true }));

    const response = await request("/workflows", jsonInit("POST", { name: "孤儿工作流" }));
    const body = await readBody(response);

    expect(response.status).toBe(500);
    expect(body.error?.code).toBe("WORKFLOW_REGISTRATION_FAILED");
    expect(upstream.calls.map((item) => item.path)).toEqual(["/api/workflow_api/create", "/api/workflow_api/delete"]);
    expect(sentBody(upstream.calls, 1).workflow_id).toBe(orphanId);
    expect(sentBody(upstream.calls, 1).space_id).toBe(SPACE_ID);
    installDatabase(database());
    expect(await findWorkflowByUpstreamId(ORG_ROUTE, orphanId)).toBeNull();
  });

  // 列表是控制台可见性的第一道闸：跨组织行与已软删行都不得出现（仓储谓词由服务层用例覆盖，这里验形状）。
  test("列表只返回本组织未软删的记录", async () => {
    const mine = await seedRecord("route-list-mine");
    const foreign = await seedRecord("route-list-foreign", ORG_A);
    const removed = await seedRecord("route-list-removed");
    await softDeleteWorkflow(ORG_ROUTE, removed.upstreamWorkflowId);

    const body = await readBody(await request("/workflows?page=1&size=50"));
    const ids = (body.data?.items ?? []).map((item) => item.upstreamWorkflowId);

    expect(ids).toContain(mine.upstreamWorkflowId);
    expect(ids).not.toContain(foreign.upstreamWorkflowId);
    expect(ids).not.toContain(removed.upstreamWorkflowId);
  });

  // 跨组织删除返回 404（存在性不泄漏）且不触碰对方行、不调上游——越权判定必须落在本地注册表上。
  test("跨组织删除返回 404 且不改动对方记录", async () => {
    const victim = await seedRecord("route-victim", ORG_A);

    const response = await request(`/workflows/${victim.id}`, { method: "DELETE" });

    expect(response.status).toBe(404);
    expect((await readRawRow(victim.upstreamWorkflowId))?.syncState).toBe("active");
    expect(upstream.calls).toHaveLength(0);
  });

  // 删除先探上游策略（非 0 表示需先下架）：未 force 时只回报策略、不软删；force 时软删并调上游删除。
  test("删除按上游策略门控，force 时软删并调上游", async () => {
    const record = await seedRecord("route-delete");
    responses["/api/workflow_api/delete_strategy"] = () => upstreamOk({ data: 2 });

    const blocked = await readBody(await request(`/workflows/${record.id}`, { method: "DELETE" }));
    expect(blocked.data?.deleted).toBe(false);
    expect(blocked.data?.strategy).toBe(2);
    expect((await readRawRow(record.upstreamWorkflowId))?.syncState).toBe("active");

    responses["/api/workflow_api/delete"] = () => upstreamOk({ data: { status: 0 } });
    const forced = await readBody(await request(`/workflows/${record.id}?force=true`, { method: "DELETE" }));
    expect(forced.data?.deleted).toBe(true);
    expect(upstream.calls.map((item) => item.path)).toContain("/api/workflow_api/delete");
    expect((await readRawRow(record.upstreamWorkflowId))?.syncState).toBe("pending_delete");
  });

  // 改名是「上游 update_meta + 本地镜像」两步：本地镜像名必须跟随，否则列表显示旧名。
  test("改名调用上游 update_meta 并更新本地镜像名", async () => {
    const record = await seedRecord("route-rename");
    responses["/api/workflow_api/update_meta"] = () => upstreamOk({});

    const response = await request(`/workflows/${record.id}`, jsonInit("PATCH", { name: "改名后" }));

    expect(response.status).toBe(200);
    expect((await readBody(response)).data?.ok).toBe(true);
    expect(sentBody(upstream.calls, 0).workflow_id).toBe(record.upstreamWorkflowId);
    expect(sentBody(upstream.calls, 0).space_id).toBe(SPACE_ID);
    expect((await findWorkflowByUpstreamId(ORG_ROUTE, record.upstreamWorkflowId))?.name).toBe("改名后");
  });
});
