// 平台账号 PAT 的生命周期契约（对外触发面唯一的 `/v1/*` 凭据）。
//
// 上游用 `Bun.serve` 起的本地假实例（与 `upstream-session.test.ts` 同一口径）：本模块只发两类请求——先用
// 平台账号会话换取 PAT（`/api/permission_api/pat/create_personal_access_token_and_permission`），再用它调
// `/v1/*`。重点断言五件事：
// ① 换取：请求体是 `duration_day` **字符串天数**（上游 `ParseInt` 后换算到期时间），成功后的令牌被缓存，
//    后续调用不再换取；
// ② 单飞：并发 `ensureToken()` 只换取一次；
// ③ 失效重建：`invalidate()` 后重新换取；`callUpstreamOpenApi` 收到 401 时重建并**重放一次**，
//    重放成功即返回上游结果；
// ④ 多副本：共享存储里的令牌由「另一个副本」发布时直接复用（用 `resetUpstreamPatLocalStateForTests` 模拟
//    本进程重启/另一个副本，共享存储保持不变）；
// ⑤ 降级：换取被上游拒绝时抛 `UpstreamSessionUnavailableError`（路由层映射 503），不做无边界重试。
//
// 凭据纪律：令牌与会话值一律运行期生成，源码里不写看起来像真凭据的字面量；断言只比对「出站头里的值与
// 存储里的值一致」，不打印任何凭据。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { callUpstreamOpenApi } from "../server/services/upstream-client";
import { resetUpstreamHealth } from "../server/services/upstream-health";
import {
  getUpstreamPat,
  resetUpstreamPatForTests,
  resetUpstreamPatLocalStateForTests,
  setUpstreamPatTimingForTests,
} from "../server/services/upstream-pat";
import { resetUpstreamPatStoreForTests } from "../server/services/upstream-pat-store";
import {
  resetUpstreamSessionLocalStateForTests,
  UpstreamSessionUnavailableError,
} from "../server/services/upstream-session";
import { initializeWorkflowV2ModuleConfig } from "../server/testing";

const LOGIN_PATH = "/api/passport/web/email/login/";
const LOCALE_PATH = "/api/passport/account/info/v2/";
const CREATE_PATH = "/api/permission_api/pat/create_personal_access_token_and_permission";
const DELETE_PATH = "/api/permission_api/pat/delete_personal_access_token_and_permission";
const RUN_PATH = "/v1/workflow/run";

/** 会话值由运行期生成（避免源码里的凭据字面量，同时足以断言出站注入）。 */
const SESSION_KEY = `session-key-fixture-${crypto.randomUUID()}`;

interface RecordedRequest {
  path: string;
  authorization: string | null;
  body: unknown;
}

let server: ReturnType<typeof Bun.serve> | null = null;
let requests: RecordedRequest[] = [];
/** 每次换取返回一枚新令牌；值由序号生成，便于断言「重建后换了新令牌」。 */
let createdCount = 0;
/** `/v1/*` 的预置响应队列；取空后回成功。 */
let runResponses: Array<() => Response> = [];
/** 换取端点的预置响应；`null` 表示走默认成功。 */
let createResponse: (() => Response) | null = null;
/** 吊销端点的预置响应；`null` 表示走默认成功。 */
let deleteResponse: (() => Response) | null = null;

function baseUrl(): string {
  if (server === null) throw new Error("假上游尚未启动");
  return `http://127.0.0.1:${server.port}`;
}

const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  requests = [];
  createdCount = 0;
  runResponses = [];
  createResponse = null;
  deleteResponse = null;
  resetAllStubs();
  resetUpstreamPatStoreForTests();
  resetUpstreamPatForTests();
  resetUpstreamSessionLocalStateForTests();
  resetUpstreamHealth();
  server ??= Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.text();
      requests.push({
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        body: body.length === 0 ? null : JSON.parse(body),
      });
      // 平台账号 locale 校正搭在 `ensureCookie` 上（另一个关注点、有自己的用例文件）：就地应答「已是 zh-CN」。
      if (url.pathname === LOCALE_PATH) return json({ code: 0, data: { locale: "zh-CN" } });
      if (url.pathname === LOGIN_PATH) {
        return new Response(JSON.stringify({ code: 0, data: { user_id_str: "upstream-user-fixture" } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": `session_key=${SESSION_KEY}; max-age=2592000; domain=127.0.0.1:18080; path=/`,
          },
        });
      }
      if (url.pathname === CREATE_PATH) {
        if (createResponse !== null) return createResponse();
        createdCount += 1;
        return json({
          code: 0,
          data: {
            token: `pat_${crypto.randomUUID()}`,
            personal_access_token: { id: `pat-id-${createdCount}` },
          },
        });
      }
      if (url.pathname === DELETE_PATH) {
        if (deleteResponse !== null) return deleteResponse();
        return json({ code: 0, msg: "" });
      }
      if (url.pathname === RUN_PATH) {
        const next = runResponses.shift();
        if (next) return next();
        return json({ code: 0, execute_id: "6900000000000000009", data: '{"output":"ok"}' });
      }
      return json({ code: 404, msg: "unexpected path" }, 404);
    },
  });
  initializeWorkflowV2ModuleConfig({ upstreamBaseUrl: baseUrl() });
});

afterEach(() => {
  setUpstreamPatTimingForTests({
    localCacheTtlMs: 5_000,
    waitMs: 8_000,
    pollIntervalMs: 250,
    renewMarginMs: 10 * 24 * 60 * 60 * 1000,
  });
});

const createCalls = () => requests.filter((item) => item.path === CREATE_PATH).length;

describe("平台账号 PAT 的换取与缓存", () => {
  // 换取请求的形状是上游合同的一部分：`duration_day` 必须是**字符串**天数（上游 `ParseInt`，`permanent`
  // 或非法值会被拒），且必须带平台账号会话（WebAPI 面）。
  test("首次调用用会话换取 PAT，请求体是字符串天数", async () => {
    const token = await getUpstreamPat().ensureToken();

    expect(token.startsWith("pat_")).toBe(true);
    expect(createCalls()).toBe(1);
    const create = requests.find((item) => item.path === CREATE_PATH);
    expect(create?.body).toEqual({ name: "fenix-agent-workflow-v2", duration_day: "30" });
    // 换取走会话面，不带 Authorization。
    expect(create?.authorization).toBeNull();
  });

  // 令牌在有效期内被缓存：第二次调用不再换取（换取是写操作，不该按调用频率放大）。
  test("有效期内复用缓存不重复换取", async () => {
    const first = await getUpstreamPat().ensureToken();
    const second = await getUpstreamPat().ensureToken();

    expect(second).toBe(first);
    expect(createCalls()).toBe(1);
  });

  // 单飞：并发的 `ensureToken()` 共享同一次换取（多副本契约的进程内那一层）。
  test("并发调用只换取一次", async () => {
    const tokens = await Promise.all([
      getUpstreamPat().ensureToken(),
      getUpstreamPat().ensureToken(),
      getUpstreamPat().ensureToken(),
    ]);

    expect(new Set(tokens).size).toBe(1);
    expect(createCalls()).toBe(1);
  });

  // 主动失效后必须重建（上游判定令牌失效时由 `callUpstreamOpenApi` 调用），且新令牌与旧的不同。
  // 这条路径**不吊销**旧令牌：它已被上游拒绝（调用方正是因此才失效的），吊销一枚已失效的令牌没有意义。
  test("失效后重建换到新令牌", async () => {
    const first = await getUpstreamPat().ensureToken();
    getUpstreamPat().invalidate();
    const second = await getUpstreamPat().ensureToken();

    expect(second).not.toBe(first);
    expect(createCalls()).toBe(2);
    expect(requests.filter((item) => item.path === DELETE_PATH)).toHaveLength(0);
  });

  // 轮换（临近到期提前重建）时**尽力吊销被替换的旧令牌**：带上游返回的令牌 ID 调吊销端点。
  // 这是长期运行的关键约束——不吊销的话，上游凭据列表会逐年累积不再使用的长期凭据。
  test("轮换时吊销被替换的旧令牌", async () => {
    await getUpstreamPat().ensureToken();
    setUpstreamPatTimingForTests({ renewMarginMs: 40 * 24 * 60 * 60 * 1000 });
    await getUpstreamPat().ensureToken();

    const revokes = requests.filter((item) => item.path === DELETE_PATH);
    expect(revokes).toHaveLength(1);
    // 吊销的是**上一枚**的 ID（不是刚换到的那一枚）。
    expect(revokes[0]?.body).toEqual({ id: "pat-id-1" });
  });

  // 吊销是尽力而为：上游拒绝时不得影响本次换取的结果（否则一次清理失败会连带把可用的新令牌判死）。
  test("吊销失败不影响换取结果", async () => {
    await getUpstreamPat().ensureToken();
    deleteResponse = () => json({ code: 500, msg: "delete failed" }, 500);
    setUpstreamPatTimingForTests({ renewMarginMs: 40 * 24 * 60 * 60 * 1000 });

    const token = await getUpstreamPat().ensureToken();

    expect(token.startsWith("pat_")).toBe(true);
    expect(createCalls()).toBe(2);
    expect(requests.filter((item) => item.path === DELETE_PATH)).toHaveLength(1);
  });

  // 多副本：另一个副本把令牌写进共享存储后，本进程（刚重启、没有任何本地记忆）直接复用而不是再换一枚。
  test("复用共享存储里由其它副本发布的令牌", async () => {
    const token = await getUpstreamPat().ensureToken();
    // 模拟「另一个副本」：清空本进程记忆但保留共享存储（本进程未配置 Redis，共享副本即进程内后端）。
    resetUpstreamPatLocalStateForTests();

    expect(await getUpstreamPat().ensureToken()).toBe(token);
    expect(createCalls()).toBe(1);
  });

  // 剩余有效期不足重建阈值时提前重建（轮换策略的判据）；阈值由时间参数压到毫秒级驱动，不等真实天数。
  test("临近到期时提前重建", async () => {
    const first = await getUpstreamPat().ensureToken();
    setUpstreamPatTimingForTests({ renewMarginMs: 40 * 24 * 60 * 60 * 1000 });
    const second = await getUpstreamPat().ensureToken();

    expect(second).not.toBe(first);
    expect(createCalls()).toBe(2);
  });

  // 换取失败如实抛「平台凭据不可用」：路由层据此回 503，且不做无边界重试（只发一次换取请求）。
  test("换取被上游拒绝时抛凭据不可用且不重试", async () => {
    createResponse = () => json({ code: 700000003, msg: "invalid param" });

    await expect(getUpstreamPat().ensureToken()).rejects.toBeInstanceOf(UpstreamSessionUnavailableError);
    expect(createCalls()).toBe(1);
  });
});

describe("OpenAPI 面调用的令牌注入与失效重放", () => {
  // 出站请求带 `Authorization: Bearer <PAT>`（上游 `/v1/*` 只认它，Cookie 无效），且不夹带会话 Cookie。
  test("以 Bearer 令牌调用 /v1 路径", async () => {
    const token = await getUpstreamPat().ensureToken();
    const result = await callUpstreamOpenApi({ path: RUN_PATH, body: { workflow_id: "1" } });

    expect(result.status).toBe(200);
    const run = requests.find((item) => item.path === RUN_PATH);
    expect(run?.authorization).toBe(`Bearer ${token}`);
  });

  // 令牌失效（HTTP 401）→ 重建 + 重放一次；重放成功即返回结果（调用方感知不到失效）。
  test("令牌失效时重建并重放一次", async () => {
    const stale = await getUpstreamPat().ensureToken();
    runResponses = [
      () => json({ code: 401, msg: "missing authorization in header" }, 401),
      () => json({ code: 0, execute_id: "6900000000000000010" }),
    ];

    const result = await callUpstreamOpenApi({ path: RUN_PATH, body: { workflow_id: "1" } });

    expect(result.status).toBe(200);
    expect(createCalls()).toBe(2);
    const authorizations = requests.filter((item) => item.path === RUN_PATH).map((item) => item.authorization);
    expect(authorizations).toHaveLength(2);
    expect(authorizations[0]).toBe(`Bearer ${stale}`);
    // 重放用的是重建后的新令牌（断言「换了令牌」而不是具体值）。
    expect(authorizations[1]).not.toBe(authorizations[0]);
  });

  // 重建后仍被判失效：如实抛「平台凭据不可用」，不循环重建（换取只发生两次：首次 + 重建一次）。
  test("重建后仍失效时抛凭据不可用且不循环", async () => {
    await getUpstreamPat().ensureToken();
    runResponses = [
      () => json({ code: 401, msg: "auth failed" }, 401),
      () => json({ code: 401, msg: "auth failed" }, 401),
    ];

    await expect(callUpstreamOpenApi({ path: RUN_PATH, body: { workflow_id: "1" } })).rejects.toBeInstanceOf(
      UpstreamSessionUnavailableError,
    );
    expect(requests.filter((item) => item.path === RUN_PATH)).toHaveLength(2);
    expect(createCalls()).toBe(2);
  });

  // 会话被踢（另一处登录/过期）时换取会回 700012006：必须重登一次再换取，否则对外触发会一直 503
  // 直到有别的会话面请求顺手重登（对外接口的可用性不依赖另一个面是否有流量）。
  test("换取遇到失效会话时重登后重试一次", async () => {
    let firstCreate = true;
    createResponse = () => {
      if (firstCreate) {
        firstCreate = false;
        return json({ code: 700012006, msg: "authentication failed: session not exist" });
      }
      createdCount += 1;
      return json({
        code: 0,
        data: { token: `pat_${crypto.randomUUID()}`, personal_access_token: { id: "pat-id-1" } },
      });
    };

    const token = await getUpstreamPat().ensureToken();

    expect(token.startsWith("pat_")).toBe(true);
    expect(createCalls()).toBe(2);
    // 出站顺序是契约：先换（用旧会话）→ 判定会话失效 → 重登 → 再换一次。
    expect(requests.map((item) => item.path)).toEqual([CREATE_PATH, LOGIN_PATH, CREATE_PATH]);
  });

  // 路径前缀是凭据契约的一部分：`/api/*` 不接受 PAT，误用必须当场被本地拒绝而不是发出一次无鉴权请求。
  test("非 /v1 路径在本地拒绝", async () => {
    await expect(callUpstreamOpenApi({ path: "/api/workflow_api/create" })).rejects.toThrow("/v1/");
  });
});
