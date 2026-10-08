// 对账任务（4A）的行为契约测试：`pending_delete` 重试与预算、孤儿补写的归属判据、创建补偿收敛、单飞与取消。
//
// 依赖一律经 `setReconciliationPorts` 注入替身：本文件断言的是**判定逻辑**（退避、上限、归属反查、失败分类），
// 不是 SQL 行为——真库测试会把「退避是否生效」绑在驱动上，还会让 `bun test` 依赖 DATABASE_URL。
// 时间由注入的时钟推进，不 sleep。
//
// 凭据纪律：本文件只出现明显假的 fixture 标识，不涉及任何真实账号、会话或票据材料。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getReconciliationStatus,
  resetReconciliationForTests,
  runReconciliationOnce,
  startReconciliationScheduler,
  stopReconciliationScheduler,
} from "../server/services/reconciliation";
import {
  PENDING_DELETE_MAX_AGE_MS,
  PENDING_DELETE_MAX_ATTEMPTS,
} from "../server/services/reconciliation-pending-delete";
import {
  BACKFILLED_OWNER_USER_ID,
  RECONCILIATION_ACTOR_USER_ID,
  setReconciliationPorts,
} from "../server/services/reconciliation-ports";
import type { UpstreamCallInput, UpstreamCallResult } from "../server/services/upstream-client";
import { UpstreamCircuitOpenError, UpstreamRequestError } from "../server/services/upstream-client";
import { initializeWorkflowV2ModuleConfig } from "../server/testing";

/** fixture 标识一律带前缀，避免与真实组织/上游 ID 混淆。 */
const ORG_A = "org-fixture-rec-a";
const ORG_B = "org-fixture-rec-b";
const APP_A = "app-fixture-rec-a";
const APP_B = "app-fixture-rec-b";
const SPACE = "space-fixture-rec";
const ROW_ID = "row-fixture-rec-1";
const WF_IN_DELETE = "wf-fixture-rec-delete";
const WF_ORPHAN = "wf-fixture-rec-orphan";

/** 上游成功信封（`code: 0` 是唯一成功判定）。 */
function ok(body: Record<string, unknown> = {}): UpstreamCallResult {
  return { status: 200, body: { code: 0, msg: "success", ...body } };
}

/** `workflow_list` 的成功响应：`project_id` 决定返回哪些对象（模拟上游的硬过滤）。 */
function listOk(items: Record<string, unknown>[]): UpstreamCallResult {
  return ok({ data: { workflow_list: items, total: items.length } });
}

/** `delete` 的成功响应：这一族端点用 `data.status === 0` 表达成功，没有 `code` 语义（契约快照 §3 F8）。 */
const deleteOk: UpstreamCallResult = { status: 200, body: { code: 0, msg: "success", data: { status: 0 } } };

/** 审计流水（断言写入内容与顺序）；字段集与仓储的 `AuditLogAppend` 对齐。 */
interface AuditEntry {
  organizationId: string;
  actorUserId: string;
  action: string;
  upstreamWorkflowId: string | null;
  requestId: string | null;
  result: string;
  errorCode: string | null;
}

interface PendingRow {
  id: string;
  organizationId: string;
  upstreamWorkflowId: string;
  deletedAt: Date;
}

/** 补写入参（只断言行为相关的列）。 */
interface InsertEntry {
  organizationId: string;
  upstreamWorkflowId: string;
  appId: string;
  name: string;
  ownerUserId: string;
  visibility: string;
}

interface Harness {
  /** 注入后的端口替身可改动的状态。 */
  pending: PendingRow[];
  known: Map<string, string[]>;
  orgApps: { organizationId: string; appId: string }[];
  registered: Map<string, { organizationId: string; syncState: string }>;
  markers: { organizationId: string; upstreamWorkflowId: string; result: string }[];
  upstreamItems: Map<string, Record<string, unknown>[]>;
  /** 每次 `delete` 调用的结果；用完后回落到 {@link Harness.deleteDefault}。 */
  deleteResults: UpstreamCallResult[];
  deleteDefault: () => UpstreamCallResult;
  insertFailure: Error | null;
  readonly calls: UpstreamCallInput[];
  readonly inserted: InsertEntry[];
  readonly purged: string[];
  readonly audits: AuditEntry[];
  advance(ms: number): void;
}

/** 装配对账替身；返回可改动的状态与调用记录。 */
function harness(options: { pending?: PendingRow[]; spaceId?: string | null } = {}): Harness {
  let now = Date.now();
  const state: Harness = {
    pending: options.pending ?? [],
    known: new Map(),
    orgApps: [{ organizationId: ORG_A, appId: APP_A }],
    registered: new Map(),
    markers: [],
    upstreamItems: new Map(),
    deleteResults: [],
    deleteDefault: () => deleteOk,
    insertFailure: null,
    calls: [],
    inserted: [],
    purged: [],
    audits: [],
    advance(ms) {
      now += ms;
    },
  };

  setReconciliationPorts({
    clock: () => now,
    callUpstream: async (input) => {
      state.calls.push(input);
      if (input.path === "/api/workflow_api/delete") {
        const queued = state.deleteResults.shift();
        return queued ?? state.deleteDefault();
      }
      const body = (input.body ?? {}) as { project_id?: unknown };
      const items = state.upstreamItems.get(String(body.project_id)) ?? [];
      return listOk(items);
    },
    listPendingDelete: async (limit) => state.pending.slice(0, limit),
    purgePendingDelete: async (organizationId, id) => {
      const index = state.pending.findIndex((row) => row.id === id && row.organizationId === organizationId);
      if (index < 0) return 0;
      state.pending.splice(index, 1);
      state.purged.push(id);
      return 1;
    },
    listKnownUpstreamIds: async (organizationId) => state.known.get(organizationId) ?? [],
    listOrgApps: async () => state.orgApps,
    findPlatformSpaceId: async () => (options.spaceId === undefined ? SPACE : options.spaceId),
    findRegisteredId: async (upstreamWorkflowId) => {
      const found = state.registered.get(upstreamWorkflowId);
      return found === undefined
        ? undefined
        : ({ organizationId: found.organizationId, syncState: found.syncState } as never);
    },
    findCompensationMarkers: async (upstreamWorkflowIds) =>
      state.markers.filter((marker) => upstreamWorkflowIds.includes(marker.upstreamWorkflowId)),
    insertWorkflow: async (input) => {
      if (state.insertFailure !== null) throw state.insertFailure;
      state.inserted.push({ ...input });
    },
    appendAuditLog: async (entry) => {
      state.audits.push(entry as AuditEntry);
    },
  });
  return state;
}

/** 只取 `delete` 调用：孤儿扫描的 `workflow_list` 与它同在一个调用列表里，断言必须按路径分开。 */
function deleteCalls(state: Harness): UpstreamCallInput[] {
  return state.calls.filter((call) => call.path === "/api/workflow_api/delete");
}

/** 一条待删行；默认「刚刚软删」（不触发年龄上限）。 */
function pendingRow(deletedAtMs: number, upstreamWorkflowId = WF_IN_DELETE, id = ROW_ID): PendingRow {
  return { id, organizationId: ORG_A, upstreamWorkflowId, deletedAt: new Date(deletedAtMs) };
}

beforeEach(() => {
  resetReconciliationForTests();
  // 周期取 0：用例只驱动 `runReconciliationOnce`，不让定时器在本进程里偷偷跑一轮。
  initializeWorkflowV2ModuleConfig({ reconcileIntervalSeconds: 0 });
});

afterEach(() => {
  resetReconciliationForTests();
});

describe("对账任务：pending_delete 收敛", () => {
  // 上游确认删除后必须终结本地行并写审计：这是「本地已不可见」与「上游已删除」两段事实的合流点。
  test("上游确认删除后终结本地行并写 reconciled 审计", async () => {
    const state = harness({ pending: [pendingRow(Date.now())] });

    const report = await runReconciliationOnce();

    expect(report.pendingDelete).toMatchObject({ scanned: 1, purged: 1, failed: 0, exhausted: 0 });
    expect(state.purged).toEqual([ROW_ID]);
    expect(state.pending).toHaveLength(0);
    expect(state.audits).toEqual([
      {
        organizationId: ORG_A,
        actorUserId: RECONCILIATION_ACTOR_USER_ID,
        action: "workflow.delete.upstream",
        upstreamWorkflowId: WF_IN_DELETE,
        requestId: null,
        result: "reconciled",
        errorCode: null,
      },
    ]);
    // 删除请求必须带权威 space_id（来自平台账号台账），客户端/调用方都不传它。
    expect(deleteCalls(state).map((call) => call.body)).toEqual([{ workflow_id: WF_IN_DELETE, space_id: SPACE }]);
  });

  // 失败必须退避：同一行在退避窗口内重复调用上游，等于把一次抖动放大成持续的上游配额消耗。
  test("删除失败后进入退避，窗口内不再打上游", async () => {
    const state = harness({ pending: [pendingRow(Date.now())] });
    state.deleteDefault = () => {
      throw new UpstreamRequestError("UPSTREAM_NETWORK_ERROR", "fixture network down");
    };

    const first = await runReconciliationOnce();
    expect(first.pendingDelete.failed).toBe(1);
    expect(first.failureReasons).toEqual({ network: 1 });
    expect(deleteCalls(state)).toHaveLength(1);

    const second = await runReconciliationOnce();
    expect(second.pendingDelete).toMatchObject({ failed: 0, deferred: 1 });
    expect(deleteCalls(state)).toHaveLength(1);
  });

  // 退避窗口过后要恢复重试（否则退避就变成了静默放弃）。
  test("退避窗口过后恢复重试并成功收敛", async () => {
    const state = harness({ pending: [pendingRow(Date.now())] });
    let attempts = 0;
    state.deleteDefault = () => {
      attempts += 1;
      if (attempts === 1) throw new UpstreamRequestError("UPSTREAM_TIMEOUT", "fixture timeout");
      return deleteOk;
    };

    await runReconciliationOnce();
    expect(state.purged).toEqual([]);
    state.advance(30_000);
    const second = await runReconciliationOnce();

    expect(second.pendingDelete.purged).toBe(1);
    expect(state.purged).toEqual([ROW_ID]);
    expect(deleteCalls(state)).toHaveLength(2);
  });

  // 次数上限：连续失败到上限后必须停止重试（不计 deferred），否则「上限」形同虚设。
  test("连续失败达到次数上限后停止重试", async () => {
    const state = harness({ pending: [pendingRow(Date.now())] });
    state.deleteDefault = () => {
      throw new UpstreamRequestError("UPSTREAM_NETWORK_ERROR", "fixture network down");
    };

    for (let attempt = 0; attempt < PENDING_DELETE_MAX_ATTEMPTS; attempt += 1) {
      await runReconciliationOnce();
      state.advance(60 * 60_000);
    }
    const callsAtLimit = deleteCalls(state).length;
    expect(callsAtLimit).toBe(PENDING_DELETE_MAX_ATTEMPTS);

    const beyond = await runReconciliationOnce();
    expect(beyond.pendingDelete).toMatchObject({ exhausted: 1, failed: 0, deferred: 0 });
    // 超限之后不再发起任何删除调用：这是「告警而不是无限重试」的可观测判据。
    expect(deleteCalls(state)).toHaveLength(callsAtLimit);
  });

  // 年龄上限是持久化的那道闸：进程重启后仍要拦住「已经失败一整天」的行（次数上限会被重启清零）。
  test("超过年龄上限的行直接进入 exhausted 且不打上游", async () => {
    const state = harness({ pending: [pendingRow(Date.now() - PENDING_DELETE_MAX_AGE_MS - 1)] });

    const report = await runReconciliationOnce();

    expect(report.pendingDelete).toMatchObject({ scanned: 1, exhausted: 1, failed: 0 });
    expect(deleteCalls(state)).toHaveLength(0);
  });

  // 平台账号台账缺行时无法调上游删除：本轮必须显式降级，而不是静默跳过（否则对账会一直「什么都没做」）。
  test("平台账号台账缺行时本轮降级并给出 local_failure", async () => {
    const state = harness({ pending: [pendingRow(Date.now())], spaceId: null });

    const report = await runReconciliationOnce();

    expect(report.degraded).toBe(true);
    expect(report.failureReasons).toEqual({ local_failure: 1 });
    expect(state.calls).toHaveLength(0);
  });
});

describe("对账任务：孤儿补写", () => {
  // 补写的归属只能来自「上游 project 列表 + 本地 App 绑定」的反查：对象出现在哪个 App 的列表里，就归哪个组织。
  test("上游存在而本地缺失时按 App 绑定反查组织并补写", async () => {
    const state = harness();
    state.known.set(ORG_A, []);
    state.upstreamItems.set(APP_A, [{ workflow_id: WF_ORPHAN, name: "上游里的名字" }]);

    const report = await runReconciliationOnce();

    expect(report.orphan).toMatchObject({ organizations: 1, upstream: 1, backfilled: 1, undetermined: 0 });
    expect(state.inserted).toEqual([
      {
        organizationId: ORG_A,
        upstreamWorkflowId: WF_ORPHAN,
        appId: APP_A,
        name: "上游里的名字",
        ownerUserId: BACKFILLED_OWNER_USER_ID,
        visibility: "private",
      },
    ]);
    // 补写要留审计（无主对象进控制台这件事必须可追溯）。
    expect(state.audits.map((entry) => [entry.action, entry.result])).toEqual([["workflow.reconcile.backfill", "ok"]]);
    // 列表查询必须注入权威 space_id 与绑定里的 project_id。
    expect(state.calls[0]?.body).toMatchObject({ space_id: SPACE, project_id: APP_A });
  });

  // 上游列表项没有名字时用上游身份兜底：宁可显示一个可检索的标识，也不能写空名（空名在控制台里无法辨认）。
  test("列表项缺 name 时用上游身份兜底且不阻断补写", async () => {
    const state = harness();
    state.upstreamItems.set(APP_A, [{ workflow_id: WF_ORPHAN }]);

    await runReconciliationOnce();

    expect(state.inserted[0]?.name).toBe(WF_ORPHAN);
  });

  // 本地已认识（含已软删的 pending_delete 行）的对象绝不补写：否则会对同 id 撞唯一索引，或把待删对象复活。
  test("本地已登记的身份不补写（含待删行）", async () => {
    const state = harness();
    state.known.set(ORG_A, [WF_ORPHAN]);
    state.upstreamItems.set(APP_A, [{ workflow_id: WF_ORPHAN }]);

    const report = await runReconciliationOnce();

    expect(report.orphan.backfilled).toBe(0);
    expect(state.inserted).toHaveLength(0);
  });

  // 越权防护一：列表项自报的 project_id 与查询条件不符时拒绝补写（上游行为变化不能被当成归属依据）。
  test("列表项 project_id 与查询条件不符时拒绝补写并计数", async () => {
    const state = harness();
    state.upstreamItems.set(APP_A, [{ workflow_id: WF_ORPHAN, project_id: APP_B }]);

    const report = await runReconciliationOnce();

    expect(report.orphan).toMatchObject({ backfilled: 0, undetermined: 1 });
    expect(state.inserted).toHaveLength(0);
  });

  // 越权防护二：身份已被别的组织登记时拒绝补写（把他人组织的对象写成自己的就是越权）。
  test("身份已被别的组织登记时拒绝补写并计数", async () => {
    const state = harness();
    state.registered.set(WF_ORPHAN, { organizationId: ORG_B, syncState: "active" });
    state.upstreamItems.set(APP_A, [{ workflow_id: WF_ORPHAN }]);

    const report = await runReconciliationOnce();

    expect(report.orphan).toMatchObject({ backfilled: 0, undetermined: 1 });
    expect(state.inserted).toHaveLength(0);
  });

  // 越权防护三：列表项没有 workflow_id 时无法确定对象身份，只告警不补写。
  test("列表项缺 workflow_id 时跳过并计数", async () => {
    const state = harness();
    state.upstreamItems.set(APP_A, [{ name: "没有 id 的条目" }]);

    const report = await runReconciliationOnce();

    expect(report.orphan).toMatchObject({ backfilled: 0, undetermined: 1 });
    expect(state.inserted).toHaveLength(0);
  });

  // 补写撞库（并发补写/用户此刻重建了同 id）计入 undetermined 并降级，不重试——下一轮的 known 集合会自愈。
  test("补写写库失败时计入 undetermined 且不重试", async () => {
    const state = harness();
    state.upstreamItems.set(APP_A, [{ workflow_id: WF_ORPHAN }]);
    state.insertFailure = new Error("fixture duplicate key");

    const report = await runReconciliationOnce();

    expect(report.orphan.undetermined).toBe(1);
    expect(report.failureReasons).toEqual({ local_failure: 1 });
    expect(state.inserted).toHaveLength(0);
  });

  // 一个组织对应一个 App：多个绑定时各查各的 project，候选不会串台。
  test("多个租户绑定时按各自 App 查询且互不串台", async () => {
    const state = harness();
    state.orgApps = [
      { organizationId: ORG_A, appId: APP_A },
      { organizationId: ORG_B, appId: APP_B },
    ];
    state.upstreamItems.set(APP_A, []);
    state.upstreamItems.set(APP_B, [{ workflow_id: "wf-fixture-rec-b", name: "B 的对象" }]);

    const report = await runReconciliationOnce();

    expect(report.orphan.organizations).toBe(2);
    expect(state.inserted.map((entry) => [entry.upstreamWorkflowId, entry.organizationId, entry.appId])).toEqual([
      ["wf-fixture-rec-b", ORG_B, APP_B],
    ]);
  });
});

describe("对账任务：创建补偿收敛", () => {
  // 未收敛的补偿标记意味着「这次创建对用户是失败的」：对象必须删掉，绝不能在补写路径上被认领。
  test("未收敛的补偿对象被删除并追加 cleaned 标记，不补写", async () => {
    const state = harness();
    state.upstreamItems.set(APP_A, [{ workflow_id: WF_ORPHAN, name: "失败创建" }]);
    state.markers = [{ organizationId: ORG_A, upstreamWorkflowId: WF_ORPHAN, result: "pending_cleanup" }];

    const report = await runReconciliationOnce();

    expect(report.orphan).toMatchObject({ cleaned: 1, backfilled: 0, cleanupFailed: 0 });
    expect(state.inserted).toHaveLength(0);
    expect(state.calls.map((call) => call.path)).toEqual([
      "/api/workflow_api/workflow_list",
      "/api/workflow_api/delete",
    ]);
    expect(state.audits.map((entry) => [entry.action, entry.result])).toEqual([
      ["workflow.create.compensation", "cleaned"],
    ]);
  });

  // 已收敛（已有 cleaned 行）的标记不再动作：审计表只追加，重复处理会永远重删同一个对象。
  test("已收敛的补偿对象既不补写也不重复删除", async () => {
    const state = harness();
    state.upstreamItems.set(APP_A, [{ workflow_id: WF_ORPHAN }]);
    state.markers = [
      { organizationId: ORG_A, upstreamWorkflowId: WF_ORPHAN, result: "pending_cleanup" },
      { organizationId: ORG_A, upstreamWorkflowId: WF_ORPHAN, result: "cleaned" },
    ];

    const report = await runReconciliationOnce();

    expect(report.orphan).toMatchObject({ cleaned: 0, backfilled: 0, undetermined: 0 });
    expect(state.calls.map((call) => call.path)).toEqual(["/api/workflow_api/workflow_list"]);
  });

  // 补偿标记的组织与 App 绑定不符时归属无法确定：既不删也不补（可能是数据被改写）。
  test("补偿标记的组织与绑定不符时跳过并计数", async () => {
    const state = harness();
    state.upstreamItems.set(APP_A, [{ workflow_id: WF_ORPHAN }]);
    state.markers = [{ organizationId: ORG_B, upstreamWorkflowId: WF_ORPHAN, result: "pending_cleanup" }];

    const report = await runReconciliationOnce();

    expect(report.orphan).toMatchObject({ cleaned: 0, backfilled: 0, undetermined: 1 });
    expect(state.calls.map((call) => call.path)).toEqual(["/api/workflow_api/workflow_list"]);
  });

  // 删除被上游拒绝时计入 cleanupFailed 并降级：下一轮仍会重试（补偿对象的存在本身就是待办）。
  test("补偿对象删除被上游拒绝时计入失败", async () => {
    const state = harness();
    state.upstreamItems.set(APP_A, [{ workflow_id: WF_ORPHAN }]);
    state.markers = [{ organizationId: ORG_A, upstreamWorkflowId: WF_ORPHAN, result: "pending_cleanup" }];
    state.deleteDefault = () => ({ status: 200, body: { code: 0, msg: "success", data: { status: 2 } } });

    const report = await runReconciliationOnce();

    expect(report.orphan.cleanupFailed).toBe(1);
    expect(report.failureReasons).toEqual({ upstream_rejected: 1 });
    expect(state.audits).toHaveLength(0);
  });
});

describe("对账任务：生命周期与失败隔离", () => {
  // 单飞：定时器与手工触发叠加时不能出现两轮同时打上游（重复删除与重复写回都源于此）。
  test("并发触发只跑一轮（重入共享同一轮）", async () => {
    const state = harness({
      pending: [pendingRow(Date.now()), pendingRow(Date.now(), "wf-fixture-rec-2", "row-2")],
    });

    const first = runReconciliationOnce();
    const second = runReconciliationOnce();
    const [a, b] = await Promise.all([first, second]);

    // 同一个 Promise 对象：第二轮没有重新扫描，也没有重复发起删除。
    expect(a).toBe(b);
    expect(deleteCalls(state)).toHaveLength(2);
  });

  // 取消：中止后立即停止后续条目（停止是有界的，不必等整轮跑完）。
  test("中止信号生效后不再处理后续条目", async () => {
    const rows = [pendingRow(Date.now(), "wf-1", "row-1"), pendingRow(Date.now(), "wf-2", "row-2")];
    const state = harness({ pending: rows });
    const controller = new AbortController();
    state.deleteDefault = () => {
      controller.abort();
      return deleteOk;
    };

    const report = await runReconciliationOnce({ signal: controller.signal });

    expect(report.pendingDelete).toMatchObject({ scanned: 2, purged: 1 });
    expect(state.purged).toEqual(["row-1"]);
  });

  // 熔断（上游已确定不可用）时不再继续扫描孤儿：failureReasons 要能区分它与普通网络抖动。
  test("熔断打开时跳过孤儿扫描并标记 circuit_open", async () => {
    const state = harness({ pending: [pendingRow(Date.now())] });
    state.deleteDefault = () => {
      throw new UpstreamCircuitOpenError("/api/workflow_api/delete", 30_000);
    };
    state.upstreamItems.set(APP_A, [{ workflow_id: WF_ORPHAN }]);

    const report = await runReconciliationOnce();

    expect(report.failureReasons).toEqual({ circuit_open: 1 });
    expect(state.inserted).toHaveLength(0);
    expect(state.calls.map((call) => call.path)).toEqual(["/api/workflow_api/delete"]);
  });

  // 上游在孤儿扫描阶段返回非成功信封：本轮提前结束并计入分类，不把「没扫到」当成「没有孤儿」。
  test("孤儿扫描被上游拒绝时提前结束并计数", async () => {
    const state = harness();
    setReconciliationPorts({
      callUpstream: async (input) => {
        state.calls.push(input);
        return { status: 200, body: { code: 777777775, msg: "fixture upstream panic" } };
      },
    });

    const report = await runReconciliationOnce();

    expect(report.orphan.upstream).toBe(0);
    expect(report.failureReasons).toEqual({ upstream_rejected: 1 });
  });

  // 状态快照是进程内可观测信号：跑完一轮后必须能看到最近一次报告与轮次时间。
  test("状态快照记录最近一轮报告", async () => {
    harness({ pending: [] });

    const before = getReconciliationStatus();
    expect(before).toMatchObject({ scheduled: false, running: false, lastReport: null, consecutiveFailures: 0 });

    await runReconciliationOnce();

    const after = getReconciliationStatus();
    expect(after.lastReport?.pendingDelete.scanned).toBe(0);
    expect(after.lastRunAt).not.toBeNull();
  });

  // 周期为 0 时不排定时器：部署方要能把对账关掉（装配期不得因此失败）。
  test("周期为 0 时不排定时器", () => {
    expect(startReconciliationScheduler()).toBe(false);
    expect(getReconciliationStatus().scheduled).toBe(false);
  });

  // 配置可读且周期为正时排上定时器，停止后复位（生命周期可取消）。
  test("周期为正时排上定时器且可停止", () => {
    initializeWorkflowV2ModuleConfig({ reconcileIntervalSeconds: 3600 });

    expect(startReconciliationScheduler()).toBe(true);
    expect(getReconciliationStatus()).toMatchObject({ scheduled: true, intervalSeconds: 3600 });

    stopReconciliationScheduler();
    expect(getReconciliationStatus().scheduled).toBe(false);
  });

  // 模块配置不可读时不排定时器也不抛错：装配期不能因为后台任务失败而整体失败。
  test("配置不可读时不排定时器且不抛错", () => {
    initializeWorkflowV2ModuleConfig();
    resetReconciliationForTests();
    // 复位会清掉模块配置替身（基础设施不可读），此时启动必须静默返回 false。
    expect(startReconciliationScheduler()).toBe(false);
  });
});
