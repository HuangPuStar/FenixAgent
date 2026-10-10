// API 渠道登记自愈（`services/api-channel-release.ts`）的行为契约。
//
// 这条路径是「对外触发接口真正可用」的关键：上游 `POST /v1/workflow/run` 只认 `connector_workflow_version`
// 里 (1024, workflow, 当前发布版本) 这一行，而该行只能由「把 App 发布到渠道」写入。重点断言六件事：
// ① 目标版本严格大于「该 App 下所有 workflow 的当前版本 + 所有 App 发布记录版本」，否则上游会静默空转；
// ② 发布请求只带 API 渠道（`connectors: {"1024": {}}`），且以调用方给定的 appId 为准（不接受客户端输入）；
// ③ 发布后必须校验目标 workflow 的版本确实推进，未推进即 `unverified`（不谎报成功）；
// ④ 非应用实体（历史 bot 绑定）→ `app_not_publishable`，不发发布请求、不重试；
// ⑤ 并发（同一 App）单飞、失败后冷却，避免把上游当重试靶子；
// ⑥ 永不抛错：传输失败、超时都归一成 `unavailable`，调用方据此保留原始运行错误。

import { beforeEach, describe, expect, test } from "bun:test";
import {
  API_CONNECTOR_ID,
  ensureApiChannelRelease,
  nextReleaseVersion,
  RELEASE_COOLDOWN_MS,
  resetApiChannelReleaseStateForTests,
} from "../server/services/api-channel-release";
import type { UpstreamCallInput, UpstreamCallResult } from "../server/services/upstream-client";

const APP_INFO_PATH = "/api/intelligence_api/search/get_draft_intelligence_info";
const PUBLISH_PATH = "/api/intelligence_api/publish/publish_project";
const PUBLISH_RECORDS_PATH = "/api/intelligence_api/publish/publish_record_list";
const WORKFLOW_LIST_PATH = "/api/workflow_api/workflow_list";
const WORKFLOW_DETAIL_INFO_PATH = "/api/workflow_api/workflow_detail_info";

const APP_ID = "9000000000000000001";
const SPACE_ID = "9000000000000000002";
const WORKFLOW_ID = "9000000000000000003";

interface StubCall {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

/** 上游替身：按路径返回预设信封，并记录每次出站（含请求体）。 */
function createStub(handlers: Record<string, (body: Record<string, unknown>, call: number) => UpstreamCallResult>) {
  const calls: StubCall[] = [];
  const perPath = new Map<string, number>();
  const call = async (input: UpstreamCallInput): Promise<UpstreamCallResult> => {
    const body = (input.body ?? {}) as Record<string, unknown>;
    calls.push({ path: input.path, body });
    const index = (perPath.get(input.path) ?? 0) + 1;
    perPath.set(input.path, index);
    const handler = handlers[input.path];
    if (handler === undefined) throw new Error(`未预设的上游路径：${input.path}`);
    return handler(body, index);
  };
  return { call, calls };
}

/** 上游成功信封。 */
function ok(data: unknown): UpstreamCallResult {
  return { status: 200, body: { code: 0, msg: "", data } };
}

/** 上游业务失败信封（HTTP 200 + 非 0 码，上游的常规失败形态）。 */
function fail(code: number, msg = "record not found"): UpstreamCallResult {
  return { status: 200, body: { code, msg } };
}

/** 默认读取处理器：App 存在、一个 workflow（版本 v0.0.4）、一条发布记录（v0.0.4）。 */
function defaultHandlers(
  overrides: Record<string, (body: Record<string, unknown>, call: number) => UpstreamCallResult> = {},
) {
  return {
    [APP_INFO_PATH]: () => ok({ intelligence_type: 2, basic_info: { id: APP_ID, space_id: SPACE_ID } }),
    [WORKFLOW_LIST_PATH]: () => ok({ workflow_list: [{ workflow_id: WORKFLOW_ID }] }),
    [WORKFLOW_DETAIL_INFO_PATH]: () =>
      ok([{ workflow_id: WORKFLOW_ID, latest_flow_version: "v0.0.4", flow_version: "", version: "" }]),
    [PUBLISH_RECORDS_PATH]: () => ok([{ publish_record_id: "1", version_number: "v0.0.4", publish_status: 5 }]),
    ...overrides,
  };
}

beforeEach(() => {
  resetApiChannelReleaseStateForTests();
});

describe("版本推导", () => {
  // 目标版本必须严格大于已存在的最大版本：同版本会让上游跳过建版本，渠道登记表静默空转。
  test("取已存在版本的最大值再 patch 自增", () => {
    expect(nextReleaseVersion([])).toBe("v0.0.1");
    expect(nextReleaseVersion(["v0.0.4"])).toBe("v0.0.5");
    expect(nextReleaseVersion(["v0.0.4", "v0.0.11", "v0.1.0"])).toBe("v0.1.1");
  });

  // 出现认不出的版本号时拒绝猜测（猜出来的版本号只会得到误导性的「未自增」或空转）。
  test("出现无法解析的版本号时返回 null", () => {
    expect(nextReleaseVersion(["v0.0.1", "not-a-version"])).toBeNull();
  });
});

describe("API 渠道登记自愈", () => {
  // 正常路径：按 max(workflow 版本, 发布记录) + 1 发布到 API 渠道，校验版本生效后返回 released。
  test("发布目标版本到 API 渠道并校验后返回 released", async () => {
    const published: string[] = [];
    const stub = createStub(
      defaultHandlers({
        [PUBLISH_PATH]: (body) => {
          published.push(String(body.version_number));
          return ok({ publish_record_id: "2" });
        },
        // 发布后校验：目标 workflow 的当前版本推进到新版本。
        [WORKFLOW_DETAIL_INFO_PATH]: (_body, call) =>
          call === 1
            ? ok([{ workflow_id: WORKFLOW_ID, latest_flow_version: "v0.0.4" }])
            : ok([{ workflow_id: WORKFLOW_ID, latest_flow_version: "v0.0.5" }]),
      }),
    );

    const outcome = await ensureApiChannelRelease(
      { upstreamWorkflowId: WORKFLOW_ID, appId: APP_ID },
      { callUpstream: stub.call },
    );

    expect(outcome).toEqual({ status: "released", version: "v0.0.5" });
    expect(published).toEqual(["v0.0.5"]);
    const publishCall = stub.calls.find((item) => item.path === PUBLISH_PATH);
    expect(publishCall?.body.project_id).toBe(APP_ID);
    // 只发 API 渠道；换任何别的 connector 都不会写运行路径要校验的那一行。
    expect(publishCall?.body.connectors).toEqual({ [String(API_CONNECTOR_ID)]: {} });
  });

  // 发布链路回成功但目标版本没生效（上游「版本已存在 → 跳过建版本」的空转）必须识别出来，不能谎报成功。
  test("发布成功但目标版本未推进时返回 unverified", async () => {
    const stub = createStub(defaultHandlers({ [PUBLISH_PATH]: () => ok({ publish_record_id: "3" }) }));

    const outcome = await ensureApiChannelRelease(
      { upstreamWorkflowId: WORKFLOW_ID, appId: APP_ID },
      { callUpstream: stub.call },
    );

    expect(outcome).toEqual({ status: "unverified", version: "v0.0.5" });
  });

  // 承载对象不是应用实体（历史 bot 绑定）：直接判定不可发布，且**不产生发布请求**。
  test("承载对象不是应用实体时返回 app_not_publishable 且不发布", async () => {
    const stub = createStub({ [APP_INFO_PATH]: () => fail(101000002) });

    const outcome = await ensureApiChannelRelease(
      { upstreamWorkflowId: WORKFLOW_ID, appId: APP_ID },
      { callUpstream: stub.call },
    );

    expect(outcome).toEqual({ status: "app_not_publishable" });
    expect(stub.calls.map((item) => item.path)).toEqual([APP_INFO_PATH]);
  });

  // 跨副本/并发发布抢输了版本号（101000002）：刷新发布记录后重算一次，仍失败才归入 rejected。
  test("版本号被并发占用时刷新记录后重试一次", async () => {
    const versions: string[] = [];
    const stub = createStub(
      defaultHandlers({
        [PUBLISH_PATH]: (body, call) => {
          versions.push(String(body.version_number));
          return call === 1 ? fail(101000002) : ok({ publish_record_id: "4" });
        },
        // 抢输的一方会把版本号写进发布记录（真实上游行为）：刷新后才能算出下一个可用版本。
        [PUBLISH_RECORDS_PATH]: (_body, call) =>
          call === 1
            ? ok([{ publish_record_id: "1", version_number: "v0.0.4", publish_status: 5 }])
            : ok([
                { publish_record_id: "1", version_number: "v0.0.4", publish_status: 5 },
                { publish_record_id: "2", version_number: "v0.0.5", publish_status: 5 },
              ]),
        [WORKFLOW_DETAIL_INFO_PATH]: (_body, call) =>
          call === 1
            ? ok([{ workflow_id: WORKFLOW_ID, latest_flow_version: "v0.0.4" }])
            : ok([{ workflow_id: WORKFLOW_ID, latest_flow_version: "v0.0.6" }]),
      }),
    );

    const outcome = await ensureApiChannelRelease(
      { upstreamWorkflowId: WORKFLOW_ID, appId: APP_ID },
      { callUpstream: stub.call },
    );

    expect(outcome).toEqual({ status: "released", version: "v0.0.6" });
    expect(versions).toEqual(["v0.0.5", "v0.0.6"]);
  });

  // 重试仍撞版本占用时如实返回 rejected（不再第三次尝试），把判断权交回调用方。
  test("重试仍被占用时返回 rejected 且总共只发两次", async () => {
    let publishes = 0;
    const stub = createStub(
      defaultHandlers({
        [PUBLISH_PATH]: () => {
          publishes += 1;
          return fail(101000002);
        },
      }),
    );

    const outcome = await ensureApiChannelRelease(
      { upstreamWorkflowId: WORKFLOW_ID, appId: APP_ID },
      { callUpstream: stub.call },
    );

    expect(outcome).toEqual({ status: "rejected", httpStatus: 200, upstreamCode: 101000002 });
    expect(publishes).toBe(2);
  });

  // 并发单飞：同一 App 的两个并发调用只发一次发布（一次发布覆盖该 App 下全部 workflow）。
  test("同一 App 的并发调用共享一次发布", async () => {
    let publishes = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stub = createStub(
      defaultHandlers({
        [PUBLISH_PATH]: async () => {
          publishes += 1;
          await gate;
          return ok({ publish_record_id: "5" });
        },
        [WORKFLOW_DETAIL_INFO_PATH]: (_body, call) =>
          ok([{ workflow_id: WORKFLOW_ID, latest_flow_version: call === 1 ? "v0.0.4" : "v0.0.5" }]),
      }),
    );

    const first = ensureApiChannelRelease(
      { upstreamWorkflowId: WORKFLOW_ID, appId: APP_ID },
      { callUpstream: stub.call },
    );
    const second = ensureApiChannelRelease(
      { upstreamWorkflowId: WORKFLOW_ID, appId: APP_ID },
      { callUpstream: stub.call },
    );
    release?.();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toEqual({ status: "released", version: "v0.0.5" });
    expect(b).toEqual({ status: "released", version: "v0.0.5" });
    expect(publishes).toBe(1);
  });

  // 失败后同一 workflow 进入冷却：窗口内的第二次调用零出站，直接拿到 cooldown（防止每次外部调用都打上游）。
  test("失败后的冷却窗口内不再出站", async () => {
    const stub = createStub(defaultHandlers({ [PUBLISH_PATH]: () => fail(777777775, "boom") }));
    const now = 1_000_000;

    const first = await ensureApiChannelRelease(
      { upstreamWorkflowId: WORKFLOW_ID, appId: APP_ID },
      { callUpstream: stub.call, now: () => now },
    );
    const callsAfterFirst = stub.calls.length;
    const second = await ensureApiChannelRelease(
      { upstreamWorkflowId: WORKFLOW_ID, appId: APP_ID },
      { callUpstream: stub.call, now: () => now + 1_000 },
    );

    expect(first).toEqual({ status: "rejected", httpStatus: 200, upstreamCode: 777777775 });
    expect(second).toEqual({
      status: "cooldown",
      retryAfterSeconds: Math.ceil((RELEASE_COOLDOWN_MS - 1_000) / 1000),
    });
    expect(stub.calls.length).toBe(callsAfterFirst);
  });

  // 传输失败（上游不可达）归一成 unavailable 而不是抛出：运行接口要保留自己的原始错误回执。
  test("上游调用抛错时返回 unavailable 而不抛出", async () => {
    const stub = createStub(
      defaultHandlers({
        [APP_INFO_PATH]: () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
    );

    const outcome = await ensureApiChannelRelease(
      { upstreamWorkflowId: WORKFLOW_ID, appId: APP_ID },
      { callUpstream: stub.call },
    );

    expect(outcome).toEqual({ status: "unavailable" });
  });
});
