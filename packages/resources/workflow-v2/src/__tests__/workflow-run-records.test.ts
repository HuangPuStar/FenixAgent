// 运行记录读路径（`GET /web/workflow-v2/run-records`）的行为契约。
//
// 上游运行清单由服务端转发 `POST /api/workflow_api/list_spans`（上游 2026-10-09 `3a028cf1` 起为真实实现；
// 此前平台曾临时只读直连上游库，已按 ADR `2026-10-09-workflow-v2-upstream-db-read.md` 的移除条件删除）。
// 重点断言七件事：
// ① 认证与归属：未认证 401、筛选目标跨组织与不存在一律 404（对外同形，不泄漏存在性）；
// ② 未绑定租户 App 时 409（与发布、创建同一张绑定失败表）；
// ③ **请求口径**：`workflow_id` 取注册表里的上游 ID，窗口是「毫秒 + 最近 7 天」且以服务端时钟为准，
//    `limit` 由服务端定，`desc_by_start_time` 恒 true，且**不多送字段**；
// ④ **响应解析**：新形状是标准信封 `{code,msg,spans}`，span 只带 trace 级字段，平台要的版本/模式/状态/节点数/
//    错误码在 `tags` 里（**状态取上游 `WorkflowExeStatus` 原值**：1 运行中 / 2 成功 / 3 失败 / 4 取消 / 5 中断），
//    `log_id` 只认 tag（span 侧会拿 span id 兜底，那不是真实日志 ID）；
// ⑤ 合并与裁剪：多目标结果按开始时间倒序合并，超过上屏上界裁剪并置 `truncated`；
// ⑥ **上游可能有更多**：任一目标返回的条数等于请求页大小即置 `hasMoreUpstream`（上游没有 `has_more`/游标，
//    只能按页满推断），与 ⑤ 的 `truncated` 互不替代；
// ⑦ 失败语义：**任一目标失败即整批失败**（业务失败 502、熔断 503），不吞成空列表——「读不到」与「上游说没有」
//    是两件事。
//
// 夹具（数据库句柄、守卫与上游替身）在 `helpers/console-plane-harness.ts`；无数据库时整组跳过（显式打印原因）。

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createWebWorkflowV2Routes } from "../server/routes/web";
import { createWebWorkflowV2RunRoutes } from "../server/routes/web/workflow-runs";
import { recordAuditTrail } from "../server/services/audit-trail";
import { type UpstreamCallResult, UpstreamCircuitOpenError } from "../server/services/upstream-client";
import { RUN_RECORD_LIMIT } from "../server/services/workflow-run-records";
import {
  cleanupTestRows,
  closeTestPool,
  createStubAuthGuard,
  createUpstreamStub,
  databaseReachable,
  installDatabase,
  ORG_A,
  OWNER_ID,
  readBody,
  request,
  seedBinding,
  seedRecord,
  sentBody,
  upstreamFail,
} from "./helpers/console-plane-harness";

type Responses = Record<string, () => UpstreamCallResult | Promise<UpstreamCallResult>>;

const LIST_SPANS_PATH = "/api/workflow_api/list_spans";

/** 上游 `list_spans` 的成功响应：标准信封 `{code, msg, spans}`（2026-10-09 起的新形状）。 */
const spansOk = (spans: unknown[]) => ({ status: 200, body: { code: 0, msg: "", spans } }) satisfies UpstreamCallResult;

/** 一条 tag（STRING / LONG 两种形态与上游一致）。 */
const stringTag = (key: string, value: string) => ({ key, tag_type: 0, value: { v_str: value } });
const longTag = (key: string, value: number) => ({ key, tag_type: 3, value: { v_long: value } });

/**
 * 一条上游 span：平台要的字段一半在 span 上、一半在 tags 里（映射口径见服务端文件头）。
 * `overrides` 覆盖 tags 时要整块给（避免半覆盖造成「看起来有值其实来自默认」的误解）。
 */
const span = (overrides: Record<string, unknown> = {}) => ({
  trace_id: "log-1",
  log_id: "log-1",
  span_id: "7694582493076258816",
  type: "Workflow",
  name: "客服问答流程",
  parent_id: "0",
  duration: 9,
  start_time: 1_791_534_594_524,
  status_code: 0,
  tags: [
    stringTag("execute_id", "7694582493076258816"),
    stringTag("version", "v0.0.2"),
    longTag("mode", 2),
    longTag("status", 2),
    longTag("node_count", 2),
    stringTag("error_code", ""),
    stringTag("log_id", "log-1"),
    longTag("duration", 9),
    longTag("created_at", 1_791_534_594_524),
  ],
  ...overrides,
});

/** 把运行路由装到一个应用上（上游端口注入替身）。 */
function createRunPlaneApp(
  guard: ReturnType<typeof createStubAuthGuard>,
  upstream: ReturnType<typeof createUpstreamStub>,
) {
  return new Elysia().use(
    createWebWorkflowV2RunRoutes({ authGuardPlugin: guard.plugin }, { callUpstream: upstream.call }),
  );
}

describe("运行记录读路径挂在 /workflow-v2 聚合入口下", () => {
  // 挂载判据与发布记录端点同款：新端点必须挂在宿主真正使用的聚合入口（`routes/web/index.ts`）下，
  // 只挂在子工厂上会是运行时 404，而子工厂的单测发现不了。未认证 → 401 即证明路由存在。
  test("未认证时运行记录端点返回 401", async () => {
    const guard = createStubAuthGuard();
    const app = createWebWorkflowV2Routes({ authGuardPlugin: guard.plugin });

    const response = await app.handle(new Request("http://localhost/workflow-v2/run-records"));

    expect(response.status).toBe(401);
    expect((await readBody(response)).error?.code).toBe("UNAUTHENTICATED");
  });
});

describe.skipIf(!databaseReachable)("运行记录与上游转发（真实 Postgres + 上游替身）", () => {
  const guard = createStubAuthGuard();
  let responses: Responses;
  let upstream: ReturnType<typeof createUpstreamStub>;
  let app: Elysia;

  beforeEach(async () => {
    installDatabase();
    await seedBinding();
    responses = {};
    upstream = createUpstreamStub(responses);
    app = createRunPlaneApp(guard, upstream);
    guard.setActor({ organizationId: ORG_A, userId: OWNER_ID });
  });

  afterAll(async () => {
    guard.setActor(null);
    await cleanupTestRows();
    await closeTestPool();
  });

  // 指定筛选目标时只发一次上游调用：`workflow_id` 取注册表里的上游 ID，窗口是毫秒且以服务端时钟为准
  // （客户端不能自定义时间范围），`limit` 由服务端定，`desc_by_start_time` 恒 true。
  test("按工作流筛选时注入上游 ID 与毫秒窗口并解析 span 与 tags", async () => {
    const record = await seedRecord("run-one");
    responses[LIST_SPANS_PATH] = () => spansOk([span()]);

    const response = await request(app, `/run-records?workflowId=${record.id}`);
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(upstream.calls).toHaveLength(1);
    const sent = sentBody(upstream.calls, 0);
    expect(sent.workflow_id).toBe(record.upstreamWorkflowId);
    expect(sent.limit).toBe(20);
    expect(sent.desc_by_start_time).toBe(true);
    expect(typeof sent.start_at).toBe("number");
    expect(typeof sent.end_at).toBe("number");
    expect(Number(sent.end_at) - Number(sent.start_at)).toBe(7 * 24 * 60 * 60 * 1000);

    expect(body.data?.items).toEqual([
      {
        workflowId: record.upstreamWorkflowId,
        workflowName: record.name,
        executeId: "7694582493076258816",
        logId: "log-1",
        version: "v0.0.2",
        mode: "release",
        status: "succeeded",
        durationMs: 9,
        createdAt: new Date(1_791_534_594_524).toISOString(),
        errorCode: null,
        nodeCount: 2,
      },
    ]);
  });

  // 请求体与上游 `ListRootSpansRequest` **逐字对应**（不多送字段）：授权由上游按工作流自身的 space 与登录用户的
  // 关系判定，平台不代它决定；多送的字段（`space_id` / `offset` / `status` / `execute_mode` …）会悄悄改变上游的
  // 查询语义，而那种偏移在上层断言里看不出来（键集完全相等才是「不多送」的判据）。
  test("请求体只含上游声明的五个字段", async () => {
    const record = await seedRecord("run-body-keys");
    responses[LIST_SPANS_PATH] = () => spansOk([]);

    await request(app, `/run-records?workflowId=${record.id}`);

    expect(Object.keys(sentBody(upstream.calls, 0)).sort()).toEqual([
      "desc_by_start_time",
      "end_at",
      "limit",
      "start_at",
      "workflow_id",
    ]);
  });

  // 状态取上游 `WorkflowExeStatus` 原值（1 运行中 / 2 成功 / 3 失败 / 4 取消 / 5 中断）：四档与未知各归其位，
  // 认不出的码不猜。`mode` 同理（1 试运行 / 2 发布运行 / 3 节点调试）。
  test("状态与模式按上游原值归一，认不出的码为 null", async () => {
    const record = await seedRecord("run-status");
    const withTags = (mode: number, status: number) =>
      span({ tags: [longTag("mode", mode), longTag("status", status)] });
    responses[LIST_SPANS_PATH] = () =>
      spansOk([withTags(1, 1), withTags(3, 3), withTags(2, 4), withTags(2, 5), withTags(9, 9)]);

    const body = await readBody(await request(app, `/run-records?workflowId=${record.id}`));

    // 五条 span 的 `created_at` 相同（同一份 fixture），因此断言按**集合**比对：这里要钉的是映射对不对，
    // 不是并列时的次序（次序由合并排序用例单独钉）。期望值写成元组：裸数组字面量会被推成 `(string|null)[]`，
    // 与收到的五档联合类型不等于同一个集合语义（`as const` 保留字面量类型，排序后仍逐项比对）。
    const expectedStatuses = ["canceled", "failed", "interrupted", "running", null] as const;
    const statuses = (body.data?.items?.map((item) => item.status) ?? []).slice().sort();
    expect(statuses).toEqual([...expectedStatuses].sort());
    const modes = body.data?.items?.map((item) => item.mode) ?? [];
    expect(modes).toContain("debug");
    expect(modes).toContain("node_debug");
    expect(modes).toContain(null);
  });

  // 空串标签归一成 null（版本/错误码/日志 ID 都可能是空串），且 `log_id` **只认 tags**：span 侧在上游为空时
  // 会拿 span id 兜底，那不是真实日志 ID，不能当 log_id 显示。
  test("空串归一为 null 且 log_id 只认 tag", async () => {
    const record = await seedRecord("run-empty-tags");
    responses[LIST_SPANS_PATH] = () =>
      spansOk([
        span({
          log_id: "7694582493076258816",
          tags: [stringTag("version", ""), stringTag("error_code", ""), stringTag("log_id", "")],
        }),
      ]);

    const body = await readBody(await request(app, `/run-records?workflowId=${record.id}`));

    expect(body.data?.items?.[0]).toMatchObject({ version: null, errorCode: null, logId: null });
  });

  // 上游窗口内没有运行：`spans: []` / `spans: null` 都是**合法空态**，不是失败。
  test("上游无记录时返回空列表且不算失败", async () => {
    const record = await seedRecord("run-empty");
    responses[LIST_SPANS_PATH] = () => spansOk([]);

    const response = await request(app, `/run-records?workflowId=${record.id}`);
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(body.data?.items).toEqual([]);
    expect(body.data?.truncated).toBe(false);

    responses[LIST_SPANS_PATH] = () => ({ status: 200, body: { code: 0, msg: "", spans: null } });
    const nullable = await readBody(await request(app, `/run-records?workflowId=${record.id}`));
    expect(nullable.data?.items).toEqual([]);
  });

  // 不筛选时逐个扇出组织内的工作流并在平台侧合并：按开始时间倒序（同刻按 workflow / 执行 ID 定序，顺序稳定）。
  test("不筛选时扇出多个工作流并按开始时间倒序合并", async () => {
    const first = await seedRecord("run-many-a");
    const second = await seedRecord("run-many-b");
    responses[LIST_SPANS_PATH] = () =>
      spansOk([
        span({ span_id: "1", tags: [longTag("created_at", 1_791_534_590_000)] }),
        span({ span_id: "2", tags: [longTag("created_at", 1_791_534_600_000)] }),
      ]);

    const body = await readBody(await request(app, "/run-records"));

    expect(upstream.calls.length).toBeGreaterThanOrEqual(2);
    // 页面级模式会对多个目标各查一次（每个目标都回同一份 fixture），因此按**集合**断言两条记录都在，
    // 并单独钉「合并后按开始时间倒序」。
    const ids = new Set(body.data?.items?.map((item) => item.executeId));
    expect(ids.has("2")).toBe(true);
    expect(ids.has("1")).toBe(true);
    const times = (body.data?.items?.map((item) => item.createdAt ?? "") ?? []).slice();
    expect(times).toEqual([...times].sort().reverse());
    // 两个工作流的记录都进来了（跨工作流合并）。
    const workflows = new Set(body.data?.items?.map((item) => item.workflowId));
    expect(workflows.has(first.upstreamWorkflowId)).toBe(true);
    expect(workflows.has(second.upstreamWorkflowId)).toBe(true);
  });

  // 上屏条数有上界：合并结果超过上界时裁剪并置 `truncated`（对话框不做翻页）。
  // 每查一个工作流回 20 条（上游单次上限内的取值），查 3 个即超过 50——用页面级模式构造这个上界。
  test("合并结果超过上屏上界时裁剪并置 truncated", async () => {
    await seedRecord("run-truncate-a");
    await seedRecord("run-truncate-b");
    await seedRecord("run-truncate-c");
    responses[LIST_SPANS_PATH] = () =>
      spansOk(Array.from({ length: 20 }, (_, index) => span({ span_id: `id-${index}` })));

    const body = await readBody(await request(app, "/run-records"));

    expect(body.data?.scannedWorkflows).toBeGreaterThanOrEqual(3);
    expect(body.data?.items).toHaveLength(RUN_RECORD_LIMIT);
    expect(body.data?.truncated).toBe(true);
    // 每个目标都回 20 条（页满），因此「上游可能还有」同样为真：两个标志讲的是两件事（上屏裁剪 vs 上游页满），
    // 可以同时为真，UI 也分别给提示。
    expect(body.data?.hasMoreUpstream).toBe(true);
  });

  // 上游没有 `has_more`/游标，只有 `limit`/`offset`：「还有更早的运行」只能按**页满**推断。判据是「等于页大小」，
  // 且这两个标志互不替代——20/19 条都远低于上屏上界，`truncated` 恒为 false。
  test("目标返回条数等于页大小时置 hasMoreUpstream，少于页大小则不置", async () => {
    const record = await seedRecord("run-page-size");
    responses[LIST_SPANS_PATH] = () =>
      spansOk(Array.from({ length: 20 }, (_, index) => span({ span_id: `page-full-${index}` })));

    const full = await readBody(await request(app, `/run-records?workflowId=${record.id}`));

    expect(full.data?.items).toHaveLength(20);
    expect(full.data?.truncated).toBe(false);
    expect(full.data?.hasMoreUpstream).toBe(true);

    responses[LIST_SPANS_PATH] = () =>
      spansOk(Array.from({ length: 19 }, (_, index) => span({ span_id: `page-short-${index}` })));

    const short = await readBody(await request(app, `/run-records?workflowId=${record.id}`));

    expect(short.data?.items).toHaveLength(19);
    expect(short.data?.hasMoreUpstream).toBe(false);
  });

  // 多目标扇出取「**任一**目标页满」而不是「全部目标页满」：这条标志回答的是「这份清单是否可能少了东西」，
  // 只要有一个工作流被截断，答案就是「可能」。
  test("多目标时任一目标页满即置 hasMoreUpstream", async () => {
    await seedRecord("run-fanout-full-a");
    await seedRecord("run-fanout-full-b");
    let call = 0;
    responses[LIST_SPANS_PATH] = () => {
      call += 1;
      return call === 1
        ? spansOk(Array.from({ length: 20 }, (_, index) => span({ span_id: `full-${index}` })))
        : spansOk([span({ span_id: "short-0" })]);
    };

    const body = await readBody(await request(app, "/run-records"));

    expect(body.data?.scannedWorkflows).toBeGreaterThanOrEqual(2);
    expect(body.data?.hasMoreUpstream).toBe(true);
  });

  // 全部目标都只回一条时不点亮提示：恒显示的说明行会污染每一次查看（与范围提示同款取舍）。
  test("所有目标都未页满时 hasMoreUpstream 为 false", async () => {
    await seedRecord("run-fanout-short-a");
    await seedRecord("run-fanout-short-b");
    responses[LIST_SPANS_PATH] = () => spansOk([span()]);

    const body = await readBody(await request(app, "/run-records"));

    expect(body.data?.scannedWorkflows).toBeGreaterThanOrEqual(2);
    expect(body.data?.hasMoreUpstream).toBe(false);
  });

  // 平台侧运行记录随响应返回且按组织隔离：它是「平台触发过几次」的唯一来源，必须与上游清单并排返回，
  // 且只收本组织 + 本 workflow 的审计行。
  test("平台侧运行记录随响应返回且按组织隔离", async () => {
    const record = await seedRecord("run-platform-rows");
    responses[LIST_SPANS_PATH] = () => spansOk([]);
    await recordAuditTrail({
      organizationId: ORG_A,
      actorUserId: OWNER_ID,
      action: "workflow.run.external",
      upstreamWorkflowId: record.upstreamWorkflowId,
      result: "ok",
      errorCode: null,
    });
    await recordAuditTrail({
      organizationId: `${ORG_A}-other`,
      actorUserId: OWNER_ID,
      action: "workflow.run.external",
      upstreamWorkflowId: record.upstreamWorkflowId,
      result: "upstream_rejected",
      errorCode: "UPSTREAM_REJECTED",
    });

    const body = await readBody(await request(app, `/run-records?workflowId=${record.id}`));

    expect(body.data?.platformRuns).toHaveLength(1);
    expect(body.data?.platformRuns?.[0]).toMatchObject({
      upstreamWorkflowId: record.upstreamWorkflowId,
      result: "ok",
      errorCode: null,
    });
  });

  // 只读端点同样按本地注册表做归属判定：别的组织的记录对外与「不存在」同形（404），不泄漏存在性，
  // 也不产生任何上游流量。
  test("跨组织筛选返回 404 且不触达上游", async () => {
    const foreign = await seedRecord("run-foreign", null, `${ORG_A}-b`);

    const response = await request(app, `/run-records?workflowId=${foreign.id}`);

    expect(response.status).toBe(404);
    expect((await readBody(response)).error?.code).toBe("WORKFLOW_NOT_FOUND");
    expect(upstream.calls).toHaveLength(0);
  });

  // 未绑定租户 App 时没有可用的绑定上下文：读记录与发布、创建走同一张绑定失败表（409 可引导修复），
  // 同样不触发上游调用。
  test("未绑定租户 App 时返回 409 且不触达上游", async () => {
    const record = await seedRecord("run-unbound", null, `${ORG_A}-c`);
    guard.setActor({ organizationId: `${ORG_A}-c`, userId: OWNER_ID });

    const response = await request(app, `/run-records?workflowId=${record.id}`);

    expect(response.status).toBe(409);
    expect((await readBody(response)).error?.code).toBe("ORG_APP_NOT_BOUND");
    expect(upstream.calls).toHaveLength(0);
  });

  // 上游业务失败（`code≠0`）如实映射为 502，且不回传上游原文（`msg` 可能含内部路径）。
  test("上游业务失败映射为 502 且不回传上游原文", async () => {
    const record = await seedRecord("run-rejected");
    responses[LIST_SPANS_PATH] = () => upstreamFail(777777775, "panic: strconv.ParseInt: /srv/app/internal.go:42");

    const response = await request(app, `/run-records?workflowId=${record.id}`);
    const body = await readBody(response);

    expect(response.status).toBe(502);
    expect(body.error?.code).toBe("UPSTREAM_REJECTED");
    expect(body.error?.message).not.toContain("panic");
    expect(body.data).toBeUndefined();
  });

  // 扇出到多个目标时「任一失败即整批失败」同样成立（上面的用例只有单目标）：一个目标成功了也不返回部分清单
  // ——部分成功会把「没读到」静默显示成「没运行过」，那只比重试更糟。两个目标都被调用（失败不中止扇出）。
  test("多目标时任一目标上游业务失败即整批 502 且不返回部分列表", async () => {
    await seedRecord("run-fanout-fail-a");
    await seedRecord("run-fanout-fail-b");
    let call = 0;
    responses[LIST_SPANS_PATH] = () => {
      call += 1;
      return call === 1 ? spansOk([span()]) : upstreamFail(777777775, "internal");
    };

    const response = await request(app, "/run-records");
    const body = await readBody(response);

    expect(upstream.calls.length).toBeGreaterThanOrEqual(2);
    expect(response.status).toBe(502);
    expect(body.error?.code).toBe("UPSTREAM_REJECTED");
    expect(body.data).toBeUndefined();
  });

  // 成功判定是「HTTP 200 **且** `code === 0`」两件事：上游回了业务码 0 但 HTTP 非 2xx（网关/反代故障态）同样
  // 不算成功——放行会把一份未必完整的清单当成完整事实。这里钉的是路由层的映射（502），不是上游行为。
  test("上游 HTTP 非 2xx 即使业务码为 0 也判失败并映射为 502", async () => {
    const record = await seedRecord("run-http-status");
    responses[LIST_SPANS_PATH] = () => ({ status: 500, body: { code: 0, msg: "", spans: [span()] } });

    const response = await request(app, `/run-records?workflowId=${record.id}`);
    const body = await readBody(response);

    expect(response.status).toBe(502);
    expect(body.error?.code).toBe("UPSTREAM_REJECTED");
    expect(body.data).toBeUndefined();
  });

  // 熔断打开时没有发出请求，与其它控制面端点同档为 503（可重试）。
  test("上游熔断打开时返回 503", async () => {
    const record = await seedRecord("run-circuit");
    responses[LIST_SPANS_PATH] = () => {
      throw new UpstreamCircuitOpenError(LIST_SPANS_PATH, 1_000);
    };

    const response = await request(app, `/run-records?workflowId=${record.id}`);

    expect(response.status).toBe(503);
    expect((await readBody(response)).error?.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  // 组织内一个工作流都没有时，扇出目标为空 = 不发任何上游请求：空目录是合法空态（不是失败），也不该产生
  // 无意义的上游流量。用独立组织（已绑定、无任何记录）才能断言「目录为空」——`ORG_A` 会被同目录用例写入。
  test("组织内没有工作流时不发上游请求且返回空列表", async () => {
    const emptyOrg = `${ORG_A}-empty`;
    await seedBinding(emptyOrg, `${emptyOrg}-app`);
    guard.setActor({ organizationId: emptyOrg, userId: OWNER_ID });

    const response = await request(app, "/run-records");
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expect(body.data?.items).toEqual([]);
    expect(body.data?.workflows).toEqual([]);
    expect(body.data?.scannedWorkflows).toBe(0);
    expect(body.data?.workflowTotal).toBe(0);
    expect(body.data?.truncated).toBe(false);
    expect(body.data?.hasMoreUpstream).toBe(false);
    expect(upstream.calls).toHaveLength(0);
  });
});
