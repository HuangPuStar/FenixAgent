import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHmac } from "node:crypto";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { Elysia } from "elysia";
import type { WorkflowV2ActorContext } from "../server/routes/dependencies";
import { createWebWorkflowV2IframeCodeRoutes } from "../server/routes/web/iframe-code";
import {
  issueCode,
  redeemCode,
  refreshTicket,
  revokeSession,
  type TicketClaims,
  verifyTicket,
} from "../server/services/iframe-ticket";
import { createWorkflowV2ModuleConfig, initializeWorkflowV2ModuleConfig } from "../server/testing";

/**
 * 画布票据（1C）的契约测试：冻结 §7 的握手链路与全部拒绝路径。
 *
 * 不依赖真实上游——本模块不访问上游（code 与票据只在进程内存里流转），因此既不需要 `Bun.serve` 假上游，
 * 也不需要网络。过期类用例用 `setSystemTime` 推进时钟，不靠 sleep 缩短测试时间。
 */

/** 签名密钥运行期生成：fixture 不是部署值，写死字面量会让安全扫描重新判断一次它是不是真凭据。 */
const TICKET_SECRET = crypto.randomUUID();

/** 与声明侧默认值一致的 TTL；用例按它们推算过期时刻。 */
const CODE_TTL_SECONDS = 60;
const TICKET_TTL_SECONDS = 900;

const USER_ID = "user-1";
const ORG_ID = "org-1";
const WORKFLOW_ID = "wf-1";

/** 把进程时钟前推（`setSystemTime` 之后 `Date.now()` 即读到推进后的时间）。 */
function advanceClock(ms: number): void {
  setSystemTime(new Date(Date.now() + ms));
}

/** 用给定密钥手工签一张票据：构造「错误密钥」「未登记的 jti」「同一 jti 另签」等实现侧无法产出的输入。 */
function signClaims(claims: TicketClaims, key: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(claims), "utf-8").toString("base64url");
  return `${encodedPayload}.${createHmac("sha256", key).update(encodedPayload).digest("base64url")}`;
}

/** 走一遍正常链路拿票据（code → redeem）；前置失败直接抛错，避免把断言埋进辅助函数。 */
function redeemFreshTicket(): { ticket: string; expiresAt: number; claims: TicketClaims } {
  const { code } = issueCode({ userId: USER_ID, orgId: ORG_ID, workflowId: WORKFLOW_ID });
  const redeemed = redeemCode(code);
  if (!redeemed) throw new Error("测试前置失败：code 兑换未返回票据");
  return redeemed;
}

/** 当前测试会话；`null` 为未认证，`organizationId` 为空串为「已认证但没有 active organization」。 */
let testSession: { userId: string; organizationId: string } | null = null;

function setTestSession(session: { userId: string; organizationId: string } | null): void {
  testSession = session;
}

/**
 * 会话守卫替身，与宿主 `sessionAuth` macro 同形：未认证 → 401；已认证 → 把 active organization 写进
 * `store.authContext`（没有组织时保持 null，那条边界必须由路由自己守住）。
 */
function createStubSessionAuthGuardPlugin() {
  return new Elysia({ name: "test-workflow-v2-session-auth" })
    .state({ authContext: null as WorkflowV2ActorContext | null })
    .macro({
      sessionAuth(enabled: boolean) {
        if (!enabled) return {};
        return {
          beforeHandle: ({ store }: { store: { authContext: WorkflowV2ActorContext | null } }) => {
            store.authContext = null;
            if (!testSession) {
              return new Response(
                JSON.stringify({ success: false, error: { code: "unauthorized", message: "Not authenticated" } }),
                { status: 401, headers: { "content-type": "application/json" } },
              );
            }
            if (testSession.organizationId) {
              store.authContext = { userId: testSession.userId, organizationId: testSession.organizationId };
            }
            return;
          },
        };
      },
    });
}

/** 路由实例文件级构造一次：守卫替身按请求期读取当前会话，`setTestSession` 即时生效。 */
const iframeCodeRoutes = createWebWorkflowV2IframeCodeRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() });

/** 调子实例的 `/iframe-code`（`/web/workflow-v2` 前缀由宿主挂载，不在本文件范围内）。 */
async function postIframeCode(body: unknown): Promise<Response> {
  return iframeCodeRoutes.handle(
    new Request("http://localhost/iframe-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  initializeWorkflowV2ModuleConfig({
    ticketSecret: TICKET_SECRET,
    codeTtlSeconds: CODE_TTL_SECONDS,
    ticketTtlSeconds: TICKET_TTL_SECONDS,
  });
  setTestSession(null);
});

afterEach(() => {
  setSystemTime();
  setTestSession(null);
});

describe("iframe-ticket：code 签发与兑换", () => {
  // 正常链路：code 兑换出的票据格式为 base64url(payload).base64url(HMAC-SHA256)，claims 绑定签发时的身份与 workflow
  test("正常签发、兑换与验签", () => {
    const { code, expiresIn } = issueCode({ userId: USER_ID, orgId: ORG_ID, workflowId: WORKFLOW_ID });
    expect(expiresIn).toBe(CODE_TTL_SECONDS);

    const redeemed = redeemCode(code);
    expect(redeemed).not.toBeNull();
    const { ticket, expiresAt, claims } = redeemed!;
    expect(claims).toMatchObject({ typ: "wf-canvas", sub: USER_ID, org: ORG_ID, wf: WORKFLOW_ID });
    expect(claims.sid).toBeTruthy();
    expect(claims.jti).toBeTruthy();
    expect(expiresAt).toBe(claims.exp);
    expect(claims.exp - claims.iat).toBe(TICKET_TTL_SECONDS);

    const [encodedPayload, signature, extra] = ticket.split(".");
    expect(extra).toBeUndefined();
    expect(encodedPayload).toBe(Buffer.from(JSON.stringify(claims), "utf-8").toString("base64url"));
    expect(signature).toBe(createHmac("sha256", TICKET_SECRET).update(encodedPayload!).digest("base64url"));
    expect(verifyTicket(ticket)).toEqual(claims);
  });

  // code 是单次消费凭据：兑换成功即失效，重复兑换必须失败（否则一次下发可换出多张票据）
  test("同一 code 第二次兑换失败", () => {
    const { code } = issueCode({ userId: USER_ID, orgId: ORG_ID, workflowId: WORKFLOW_ID });
    expect(redeemCode(code)).not.toBeNull();
    expect(redeemCode(code)).toBeNull();
  });

  // code 按 TTL 过期：到期前一秒仍可兑换，到点即失败（TTL 由模块配置给出，不写死在模块里）
  test("code 到期即兑换失败", () => {
    const stillValid = issueCode({ userId: USER_ID, orgId: ORG_ID, workflowId: WORKFLOW_ID });
    const expired = issueCode({ userId: USER_ID, orgId: ORG_ID, workflowId: WORKFLOW_ID });

    advanceClock(CODE_TTL_SECONDS * 1000 - 1000);
    expect(redeemCode(stillValid.code)).not.toBeNull();
    advanceClock(1000);
    expect(redeemCode(expired.code)).toBeNull();
  });

  // 未知 code 与已消费 code 同形返回 null：不给调用方按错误区分「code 是否存在」的探测面
  test("未知 code 兑换返回 null", () => {
    expect(redeemCode("not-a-real-code")).toBeNull();
  });
});

describe("iframe-ticket：票据校验", () => {
  // 票据按 TTL 过期：到期前一秒仍可验签，到点即拒绝
  test("票据到期即验签失败", () => {
    const { ticket } = redeemFreshTicket();
    advanceClock(TICKET_TTL_SECONDS * 1000 - 1000);
    expect(verifyTicket(ticket)).not.toBeNull();
    advanceClock(1000);
    expect(verifyTicket(ticket)).toBeNull();
  });

  // 篡改 payload（延长 exp）后签名对不上：必须拒绝，同时原件不受影响（签名覆盖整段载荷）
  test("篡改 payload 后验签失败", () => {
    const { ticket, claims } = redeemFreshTicket();
    const [encodedPayload, signature] = ticket.split(".");
    const tampered = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf-8")) as TicketClaims;
    tampered.exp = claims.exp + 3600;
    const tamperedPayload = Buffer.from(JSON.stringify(tampered), "utf-8").toString("base64url");

    expect(verifyTicket(`${tamperedPayload}.${signature}`)).toBeNull();
    expect(verifyTicket(ticket)).toEqual(claims);
  });

  // 用其它密钥签发的票据（载荷与 jti 都合法）必须被拒：验签是固定时间比较，不接受任何降级
  test("错误密钥签发的票据被拒", () => {
    const { ticket, claims } = redeemFreshTicket();
    const [encodedPayload] = ticket.split(".");
    const wrongKeyTicket = signClaims(claims, crypto.randomUUID());

    expect(wrongKeyTicket).not.toBe(ticket);
    expect(verifyTicket(wrongKeyTicket)).toBeNull();
    expect(
      verifyTicket(
        `${encodedPayload}.${createHmac("sha256", crypto.randomUUID()).update(encodedPayload!).digest("base64url")}`,
      ),
    ).toBeNull();
    expect(verifyTicket(ticket)).toEqual(claims);
  });

  // 同一 jti 只允许对应一张票据：用同一 jti 另签的第二张（重放/改写）被拒，而同一张票据的重复出示必须通过
  // （画布每个透传请求都带同一张票据，若把首次验签当消费，BFF 的第二个请求就会自锁）
  test("同一 jti 被重复使用时验签被拒", () => {
    const { ticket, claims } = redeemFreshTicket();
    const replayedWithSameJti = signClaims({ ...claims, exp: claims.exp + 3600 }, TICKET_SECRET);

    expect(verifyTicket(replayedWithSameJti)).toBeNull();
    expect(verifyTicket(ticket)).toEqual(claims);
    expect(verifyTicket(ticket)).toEqual(claims);
  });

  // 本进程没签发过的 jti 一律拒绝（重启后/其它副本/手工构造）：旧票据不会因重启或跨副本而复活
  test("未登记的 jti 即使签名正确也被拒", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const foreign = signClaims(
      {
        typ: "wf-canvas",
        sid: crypto.randomUUID(),
        sub: USER_ID,
        org: ORG_ID,
        wf: WORKFLOW_ID,
        iat: nowSeconds,
        exp: nowSeconds + TICKET_TTL_SECONDS,
        jti: crypto.randomUUID(),
      },
      TICKET_SECRET,
    );

    expect(verifyTicket(foreign)).toBeNull();
  });

  // 时钟回拨超过 60s 容忍窗口时，签发时间落在未来的票据被拒（跨副本时钟偏差的兜底）
  test("签发时间超出时钟偏差容忍的票据被拒", () => {
    const { ticket } = redeemFreshTicket();
    setSystemTime(new Date(Date.now() - 120_000));
    expect(verifyTicket(ticket)).toBeNull();
  });

  // 密钥缺失时不静默降级（既不退回内置默认密钥、也不把票据一律判成无效）：签发与验签都必须抛错
  test("签名密钥缺失时签发与验签都抛错", () => {
    const { ticket } = redeemFreshTicket();
    resetAllStubs();
    initializeTestApplicationInfrastructure({
      moduleConfigs: { "workflow-v2": { ...createWorkflowV2ModuleConfig(), ticketSecret: "" } },
    });

    expect(() => issueCode({ userId: USER_ID, orgId: ORG_ID, workflowId: WORKFLOW_ID })).toThrow("ticketSecret");
    expect(() => verifyTicket(ticket)).toThrow("ticketSecret");
  });

  // 结构不合法的输入一律返回 null 而不抛错：段数错误、非 base64 载荷、typ 漂移、字段缺失
  test("结构非法或 typ 漂移的票据一律拒绝", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const base: TicketClaims = {
      typ: "wf-canvas",
      sid: crypto.randomUUID(),
      sub: USER_ID,
      org: ORG_ID,
      wf: WORKFLOW_ID,
      iat: nowSeconds,
      exp: nowSeconds + TICKET_TTL_SECONDS,
      jti: crypto.randomUUID(),
    };
    const wrongTyp = signClaims({ ...base, typ: "skill-download" as TicketClaims["typ"] }, TICKET_SECRET);
    const missingJti = signClaims({ ...base, jti: "" }, TICKET_SECRET);

    expect(verifyTicket("")).toBeNull();
    expect(verifyTicket("only-one-segment")).toBeNull();
    expect(verifyTicket("a.b.c")).toBeNull();
    expect(verifyTicket("!!!.???")).toBeNull();
    expect(verifyTicket(wrongTyp)).toBeNull();
    expect(verifyTicket(missingJti)).toBeNull();
  });
});

describe("iframe-ticket：撤销与续期", () => {
  // 撤销会话后该 sid 的票据立即失效（宿主登出/切组织的路径），且不可再借续期绕过
  test("撤销 sid 后票据失效且不能续期", () => {
    const { ticket, claims } = redeemFreshTicket();
    revokeSession(claims.sid);

    expect(verifyTicket(ticket)).toBeNull();
    expect(refreshTicket(ticket)).toBeNull();
  });

  // 撤销只作用于目标会话：其它 sid（如另一个标签页）的票据不受影响
  test("撤销不影响其它会话的票据", () => {
    const first = redeemFreshTicket();
    const second = redeemFreshTicket();
    revokeSession(first.claims.sid);

    expect(verifyTicket(first.ticket)).toBeNull();
    expect(verifyTicket(second.ticket)).toEqual(second.claims);
  });

  // 续期只换 jti 不延长会话：新票据与原票据同 sid、exp 不超过原 exp，旧票据按原 exp 自然过期
  test("续期不延长会话", () => {
    const first = redeemFreshTicket();
    advanceClock(60_000);

    const refreshed = refreshTicket(first.ticket);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.claims.jti).not.toBe(first.claims.jti);
    expect(refreshed!.claims.sid).toBe(first.claims.sid);
    expect(refreshed!.claims.exp).toBe(Math.min(first.claims.exp, Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS));
    expect(verifyTicket(refreshed!.ticket)).toEqual(refreshed!.claims);
    expect(verifyTicket(first.ticket)).toEqual(first.claims);
  });
});

describe("iframe-ticket：内存回收", () => {
  // 过期项由惰性回收清理：跨越回收间隔后未过期的 code/票据仍可用（回收不得误伤有效凭据）
  test("回收不误伤未过期的凭据", () => {
    const { code } = issueCode({ userId: USER_ID, orgId: ORG_ID, workflowId: WORKFLOW_ID });
    const { ticket } = redeemFreshTicket();

    advanceClock(31_000);
    expect(redeemCode(code)).not.toBeNull();
    expect(verifyTicket(ticket)).not.toBeNull();

    // 再跨过 code/票据的 TTL 与回收间隔：已过期的凭据一律失败，回收路径不会让它们复活
    advanceClock(TICKET_TTL_SECONDS * 1000 + 31_000);
    expect(verifyTicket(ticket)).toBeNull();
    expect(redeemCode(code)).toBeNull();
  });
});

describe("iframe-code 路由", () => {
  // 未认证请求在守卫处被 401 拒绝，不签发任何凭据
  test("未认证请求被守卫拒绝", async () => {
    setTestSession(null);
    const response = await postIframeCode({ workflowId: WORKFLOW_ID });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ success: false });
  });

  // 已认证但缺少组织上下文时不签发：没有组织就没有可绑定的租户边界
  test("缺少组织上下文的会话不签发 code", async () => {
    setTestSession({ userId: USER_ID, organizationId: "" });
    const response = await postIframeCode({ workflowId: WORKFLOW_ID });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ success: false, error: { code: "unauthorized" } });
  });

  // 正常签发：返回 { code, expiresIn }，兑换出的 claims 只认会话身份（客户端无法指定绑定对象）
  test("签发成功且只认会话身份", async () => {
    setTestSession({ userId: "session-user", organizationId: "session-org" });
    const response = await postIframeCode({ workflowId: WORKFLOW_ID });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { success: boolean; data: { code: string; expiresIn: number } };
    expect(payload.success).toBe(true);
    expect(payload.data.expiresIn).toBe(CODE_TTL_SECONDS);

    const redeemed = redeemCode(payload.data.code);
    expect(redeemed).not.toBeNull();
    expect(redeemed!.claims).toMatchObject({ sub: "session-user", org: "session-org", wf: WORKFLOW_ID });
  });

  // 请求体夹带 userId/orgId 直接 422：自报身份在这里既无效也可察觉，不会被静默忽略
  test("请求体夹带 userId/orgId 被拒", async () => {
    setTestSession({ userId: USER_ID, organizationId: ORG_ID });
    const response = await postIframeCode({ workflowId: WORKFLOW_ID, userId: "attacker", orgId: "attacker-org" });

    expect(response.status).toBe(422);
  });

  // 缺少 workflowId 的请求被校验拒绝：凭据必须绑定到具体工作流，缺绑定对象不能签发
  test("缺少 workflowId 的请求被拒绝", async () => {
    setTestSession({ userId: USER_ID, organizationId: ORG_ID });
    const response = await postIframeCode({});

    expect(response.status).toBe(422);
  });
});
