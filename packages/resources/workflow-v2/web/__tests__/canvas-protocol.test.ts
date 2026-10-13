// web/__tests__/canvas-protocol.test.ts
// 画布宿主页的线协议与状态推导（纯函数面）。
//
// 为什么单独钉住这几条：它们是宿主与画布**两侧**共同的契约（冻结 §7）——参数名、信封版本、载荷字段
// 一旦漂移，宿主与画布都不会报错，只会静默失联（画布拿不到票据 → 请求全部 401；宿主把 `space_id`
// 拼成空值 → 画布读到空空间）。因此这里逐字断言形状，而不是断言实现细节。

import { describe, expect, test } from "bun:test";
import { CANVAS_API_BASE } from "../api/canvas-session";
import {
  type CanvasUpstreamProbe,
  canvasAnnouncementKey,
  resolveCanvasUpstream,
  resolveCanvasViewState,
} from "../pages/canvas/canvas-hosting-model";
import {
  buildCanvasFrameUrl,
  CANVAS_FRAME_PATH,
  CANVAS_FRAME_THEME,
  createHostMessage,
  parseCanvasMessage,
  readCanvasErrorRetryable,
  toCanvasLanguage,
} from "../pages/canvas/canvas-protocol";

describe("画布 iframe URL", () => {
  // 参数名必须是上游画布入口自己读的名字（`workflow_id` / `space_id` / `lng`），
  // 自造 `wf` / `view` / `locale` 一套再指望画布翻译是 1F 实测否定过的做法（冻结 §7）。
  test("直接拼上游认识的名字，且 apiBase 指向 BFF", () => {
    const url = buildCanvasFrameUrl({ upstreamWorkflowId: "wf-1", platformSpaceId: "space-1", language: "zh-CN" });

    expect(url.startsWith(`${CANVAS_FRAME_PATH}?`)).toBe(true);
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(params.get("workflow_id")).toBe("wf-1");
    expect(params.get("space_id")).toBe("space-1");
    expect(params.get("apiBase")).toBe(CANVAS_API_BASE);
    expect(params.get("lng")).toBe("zh-CN");
    expect(params.get("theme")).toBe(CANVAS_FRAME_THEME);
    for (const forbidden of ["wf", "view", "locale"]) expect(params.has(forbidden)).toBe(false);
  });

  // id 里出现 `&` / `=` 时必须编码，否则画布会把后半截当成另一个参数。
  test("参数值按 query 规则编码", () => {
    const url = buildCanvasFrameUrl({ upstreamWorkflowId: "a&b=c", platformSpaceId: "space 1", language: "en" });
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(params.get("workflow_id")).toBe("a&b=c");
    expect(params.get("space_id")).toBe("space 1");
    expect(url).toContain("workflow_id=a%26b%3Dc");
  });

  // i18n 检测器读的是 `lng`；只有 en 系语言走英文，其余（含未识别、undefined）一律中文。
  test("语言归一：en 系走 en，其余走 zh-CN", () => {
    expect(toCanvasLanguage("en")).toBe("en");
    expect(toCanvasLanguage("en-US")).toBe("en");
    expect(toCanvasLanguage("zh")).toBe("zh-CN");
    expect(toCanvasLanguage("zh-CN")).toBe("zh-CN");
    expect(toCanvasLanguage(undefined)).toBe("zh-CN");
  });
});

describe("父子消息信封", () => {
  test("构造的信封版本为 1、id 不重复、ts 是数字", () => {
    const first = createHostMessage("token", { ticket: "t1" });
    const second = createHostMessage("signout", {});
    expect(first.v).toBe(1);
    expect(first.ts).toBeNumber();
    expect(first.type).toBe("token");
    expect(first.payload).toEqual({ ticket: "t1" });
    expect(second.id).not.toBe(first.id);
  });

  // 版本不符、缺 type、非对象的消息一律丢弃：协议演进时不认识的消息不该被当成有效指令。
  test("只接受 v=1 且带 type 的对象", () => {
    expect(parseCanvasMessage({ v: 1, type: "ready", payload: { capabilities: ["ticket"] } })).toEqual({
      type: "ready",
      payload: { capabilities: ["ticket"] },
    });
    expect(parseCanvasMessage({ v: 2, type: "ready" })).toBeNull();
    expect(parseCanvasMessage({ v: 1 })).toBeNull();
    expect(parseCanvasMessage({ v: 1, type: "" })).toBeNull();
    expect(parseCanvasMessage({ v: 1, type: 7 })).toBeNull();
    expect(parseCanvasMessage("ready")).toBeNull();
    expect(parseCanvasMessage(null)).toBeNull();
  });

  // `retryable` 只有显式 true 才算可重试（画布侧载荷字段，冻结 §7）：缺失或字符串一律不给重试入口。
  test("error 载荷的 retryable 只在显式 true 时为真", () => {
    expect(readCanvasErrorRetryable({ code: "500", message: "x", retryable: true })).toBe(true);
    expect(readCanvasErrorRetryable({ code: "500", retryable: false })).toBe(false);
    expect(readCanvasErrorRetryable({ retryable: "true" })).toBe(false);
    expect(readCanvasErrorRetryable(undefined)).toBe(false);
  });
});

const BINDING_ACTIVE = { appId: "app-1", status: "active" } as const;
const ACCOUNT_ACTIVE = { spaceId: "space-1", status: "active" } as const;

describe("上游就绪判定", () => {
  test("探测中与探测失败分别是 pending / probe-failed", () => {
    expect(resolveCanvasUpstream({ status: "pending" })).toEqual({ state: "pending" });
    // 取不到绑定与「确实没绑定」必须分开：前者是基础设施失败（可重试），后者要引导管理员去绑定。
    expect(resolveCanvasUpstream({ status: "failed" })).toEqual({ state: "blocked", reason: "probe-failed" });
  });

  test("未绑定（status=unbound 或 appId=null）→ unbound", () => {
    expect(
      resolveCanvasUpstream({ status: "loaded", binding: { appId: null, status: "unbound" }, account: ACCOUNT_ACTIVE }),
    ).toEqual({ state: "blocked", reason: "unbound" });
    expect(
      resolveCanvasUpstream({ status: "loaded", binding: { appId: null, status: "active" }, account: ACCOUNT_ACTIVE }),
    ).toEqual({ state: "blocked", reason: "unbound" });
  });

  test("绑定被上游标记不可用 → degraded", () => {
    expect(
      resolveCanvasUpstream({
        status: "loaded",
        binding: { appId: "app-1", status: "degraded" },
        account: ACCOUNT_ACTIVE,
      }),
    ).toEqual({ state: "blocked", reason: "degraded" });
  });

  // 平台空间 ID 是画布 URL 的 `space_id` 唯一来源（不是 workflow 记录里的字段）：拿不到就不拼 URL，
  // 绝不用空值兜底（`space_id=` 会让画布读到空串并当成有效空间）。
  test("平台空间缺失 → space-missing，而不是空值拼 URL", () => {
    const blocked = resolveCanvasUpstream({
      status: "loaded",
      binding: BINDING_ACTIVE,
      account: { spaceId: null, status: "active" },
    });
    expect(blocked).toEqual({ state: "blocked", reason: "space-missing" });
    expect(
      resolveCanvasUpstream({
        status: "loaded",
        binding: BINDING_ACTIVE,
        account: { spaceId: "   ", status: "active" },
      }),
    ).toEqual({ state: "blocked", reason: "space-missing" });
  });

  // 平台账号的 status 不参与判定：会话失效由 BFF 的单飞重登自愈，在这里拦会把可自愈场景误判成不可用。
  test("平台账号会话 degraded 但空间已知 → 仍可进入画布", () => {
    const probe: CanvasUpstreamProbe = {
      status: "loaded",
      binding: BINDING_ACTIVE,
      account: { spaceId: "space-1", status: "degraded" },
    };
    expect(resolveCanvasUpstream(probe)).toEqual({ state: "ready", platformSpaceId: "space-1" });
  });
});

describe("视图状态与读屏播报", () => {
  test("上游未定时是 loading，未就绪时是 blocked（两者都不挂 iframe）", () => {
    expect(resolveCanvasViewState({ upstream: { state: "pending" }, phase: "connecting", retryable: true })).toEqual({
      kind: "loading",
    });
    expect(
      resolveCanvasViewState({
        upstream: { state: "blocked", reason: "unbound" },
        phase: "connecting",
        retryable: true,
      }),
    ).toEqual({ kind: "blocked", reason: "unbound" });
  });

  test("上游就绪后进入 frame 分支并保留握手阶段", () => {
    expect(
      resolveCanvasViewState({
        upstream: { state: "ready", platformSpaceId: "space-1" },
        phase: "canvas-error",
        retryable: false,
      }),
    ).toEqual({ kind: "frame", phase: "canvas-error", retryable: false });
  });

  // 播报只区分「听得出来」的语义：loading / blocked / connecting / ready / failed / session-expired。
  test("播报键按阶段收敛", () => {
    expect(canvasAnnouncementKey({ kind: "loading" })).toBe("canvas.announce.loading");
    expect(canvasAnnouncementKey({ kind: "blocked", reason: "probe-failed" })).toBe("canvas.announce.blocked");
    expect(canvasAnnouncementKey({ kind: "frame", phase: "connecting", retryable: true })).toBe(
      "canvas.announce.connecting",
    );
    expect(canvasAnnouncementKey({ kind: "frame", phase: "interactive", retryable: true })).toBe(
      "canvas.announce.ready",
    );
    expect(canvasAnnouncementKey({ kind: "frame", phase: "timeout", retryable: true })).toBe("canvas.announce.failed");
    expect(canvasAnnouncementKey({ kind: "frame", phase: "load-failed", retryable: true })).toBe(
      "canvas.announce.failed",
    );
    expect(canvasAnnouncementKey({ kind: "frame", phase: "handshake-failed", retryable: true })).toBe(
      "canvas.announce.failed",
    );
    expect(canvasAnnouncementKey({ kind: "frame", phase: "canvas-error", retryable: false })).toBe(
      "canvas.announce.failed",
    );
    expect(canvasAnnouncementKey({ kind: "frame", phase: "session-expired", retryable: true })).toBe(
      "canvas.announce.sessionExpired",
    );
  });
});
