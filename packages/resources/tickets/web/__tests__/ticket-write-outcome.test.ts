// web/__tests__/ticket-write-outcome.test.ts
// 创建写路径的契约（前端合同 §8.1 第 8、9 条，以及第 14 条里不依赖弹窗挂载的那部分）：
// 202 受理体判别、表单校验规则、创建请求形状与两种响应形状的落点。
//
// 为什么值得单独钉：这几条都不依赖界面，但错了都会静默劣化——
//   - 判别错的后果分两种：把 201 工单当成 202 → 用户被告知「结果确认中」却明明建单成功（跳转丢失）；
//     把 202 当成 201 → 界面宣布「已创建」并跳到一个索引里还不存在的工单（上游其实未定）。
//   - 幂等键持有者错一次就与服务端的去重账本脱钩：每次重试都换新键，服务端只能重复建单
//     （方案 §9 的重复请求语义是「同键同内容返回原操作」）；键最终由 `ticketApi.create` 写进
//     `Idempotency-Key` 请求头，头没带上等于键白生成。
//   - 正文是后端必填（`min(1)`）：校验规则放空会让用户提交出一次必然 400 的请求。
//
// 本文件不碰 DOM、不渲染组件、不 mock 任何模块：`web/lib/ticket-write-outcome.ts` 本身把 React / i18n /
// UI 图标排除在外；表单校验规则取自创建弹窗导出的 `ticketFormSchema`（同一份 schema 既驱动
// react-hook-form 的解析，也是下面几条断言的被测对象）；请求形状用替换 `globalThis.fetch` 的方式观察。
//
// **弹窗内的界面后果（202 的持久提示条、201 的跳转）不在这里**：它们依赖 ui-components 的 Radix 弹窗，
// 而 Radix 覆盖层在同进程跑完全部包的 `bun test packages/` 里不挂载（实测：先加载过
// `packages/ui-components/web/__tests__/message.ssr.test.tsx` 的组合下 `Portal` 的挂载 effect 不执行）。
// 该限制与覆盖缺口见交付报告。

import { describe, expect, test } from "bun:test";

import type { TicketCreateResult, TicketDetail, TicketWriteResult } from "../api/tickets";
import { ticketApi } from "../api/tickets";
import {
  createIdempotencyKeyHolder,
  isUncertainAccepted,
  ticketFormSignature,
  writeSignature,
} from "../lib/ticket-write-outcome";
import { ticketFormSchema } from "../pages/agent-panel/components/ticket-create-dialog";

/** 201 工单本体：字段与后端 `TicketDetailViewSchema` 一致（含 `web/api/tickets.ts` 回填的 `projectId`）。 */
const CREATED_TICKET: TicketDetail = {
  issueNumber: "42",
  title: "登录后跳转空白页",
  state: "open",
  author: { id: "user-1", name: "张三", source: "aos" },
  assignee: null,
  labels: [],
  version: "v1",
  providerUpdatedAt: "2026-10-12T08:00:00.000Z",
  syncedAt: "2026-10-12T08:00:01.000Z",
  syncStatus: "ready",
  body: "复现步骤……",
  pendingOperationId: null,
  projectId: "11111111-1111-4111-8111-111111111111",
};

describe("创建响应判别 isUncertainAccepted", () => {
  // 201 是「工单已建」的唯一证据：误判成 202 会让页面留在列表并提示「结果确认中」，
  // 用户既看不到已建成的工单、也不会再试一次（他会以为还没成功）。
  test("201 工单本体判为已创建（不是 202 受理体）", () => {
    const result: TicketCreateResult = { ticket: CREATED_TICKET, operationId: "op-1" };
    expect(isUncertainAccepted(result)).toBe(false);
  });

  // 202 的语义是「上游写入结果未定」：误判成 201 会让界面宣布成功并跳到索引里还不存在的工单。
  test("202 受理体（operationId + status: uncertain）判为待确认", () => {
    const result: TicketCreateResult = { operationId: "op-2", status: "uncertain" };
    expect(isUncertainAccepted(result)).toBe(true);
  });

  // 判别依据是 `status` 的**存在性**（201 的工单本体只有 `state`，不存在同名歧义，见 lib 文件头）：
  // 因此一个只有 operationId、没有 status 的伪体必须落到 201 分支之外，绝不能被当成「待确认」——
  // 那种形状既不可能是 202（服务端 schema 强制 operationId + status 同时存在），也不可能被渲染成工单。
  test("只有 operationId、无 status 的伪体不判为 202 受理体", () => {
    const pseudo = { operationId: "op-3" } as unknown as TicketCreateResult;
    expect(isUncertainAccepted(pseudo)).toBe(false);
    // 反向自检：加回 status 后同一条断言必须翻转，否则上面那条可能只是因为函数恒返回 false 而假绿。
    expect(isUncertainAccepted({ ...pseudo, status: "uncertain" } as TicketCreateResult)).toBe(true);
  });

  // 入参放宽成泛型联合后，评论 / 标签 / 工单修改的写结果走同一个判别函数：判别错的后果与创建一致
  //（把 200 当成待确认 → 用户被告知「确认中」却明明写入成功；把 202 当成成功 → 宣布一件未定的事已完成）。
  // 这里同时验证收窄方向：200 分支必须仍能取到 `.ticket`/`.comment` 这类资源体。
  test("工单更新结果同样按 status 判别，200 分支保留资源体", () => {
    const success: TicketWriteResult = { ticket: CREATED_TICKET, operationId: "op-4" };
    const accepted: TicketWriteResult = { operationId: "op-5", status: "uncertain" };

    expect(isUncertainAccepted(success)).toBe(false);
    expect(isUncertainAccepted(accepted)).toBe(true);
    if (isUncertainAccepted(success)) throw new Error("200 结果被误判为受理体");
    expect(success.ticket.pendingOperationId).toBeNull();
  });
});

describe("写请求的内容指纹与换代", () => {
  // 指纹是「同键不同内容」判定的另一半：字段按固定顺序拼装，`null` / `undefined` 归一成空串，
  // 因此「正文缺省」与「正文为空串」是同一次提交。分隔符必须保留——少拼一个字段（末尾空串）应当
  // 得到不同指纹，否则服务端按 A 内容持久化的键会被前端当成 B 内容的重试。
  test("writeSignature 稳定、空值归一，且不把少一个字段与空串混同", () => {
    expect(writeSignature(["标题", null, "正文"])).toBe(writeSignature(["标题", undefined, "正文"]));
    expect(writeSignature([])).toBe("");
    expect(writeSignature(["标题"])).not.toBe(writeSignature(["标题", ""]));
  });

  // `expectedVersion` 必须参与指纹：冲突后用户刷新拿到新版本，指纹随之变化 → 自动换新键。
  // 若漏掉版本，重试会命中服务端已持久化的那次失败（失败重放），永远发不出去。
  test("writeSignature 含 expectedVersion：版本变化即指纹变化", () => {
    expect(writeSignature(["标题", "v1"])).not.toBe(writeSignature(["标题", "v2"]));
  });

  // 换代点：动作成功之后（同一界面要能连发第二个动作，如内联评论框连发两条）与明确失败/幂等冲突之后
  // 都要 `reset()`；reset 之后再取一次必须是新键，否则第二次提交会被服务端当成第一次的重放。
  test("holder.reset() 之后再取键换代，未 reset 时同内容复用", () => {
    let counter = 0;
    const holder = createIdempotencyKeyHolder(() => {
      counter += 1;
      return `key-${counter}`;
    });

    const first = holder.take("body:第一条");
    expect(holder.take("body:第一条")).toBe(first);

    holder.reset();
    const second = holder.take("body:第一条");
    expect(second).not.toBe(first);
    expect(second).toBe("key-2");
  });
});

describe("一次用户动作的幂等键持有者", () => {
  // 服务端的去重单位是「同键同内容返回原操作」：同内容重试（网络超时后用户再点一次「创建」）
  // 必须复用同一个键，否则每次调用都是新操作，用户会建出两条工单。
  test("同内容重复提交复用同一个键", () => {
    const issued: string[] = [];
    const holder = createIdempotencyKeyHolder(() => {
      const key = `key-${issued.length + 1}`;
      issued.push(key);
      return key;
    });

    const first = holder.take(ticketFormSignature({ title: "标题", body: "正文" }));
    const second = holder.take(ticketFormSignature({ title: "标题", body: "正文" }));

    expect(second).toBe(first);
    expect(issued).toEqual(["key-1"]);
  });

  // 内容变化必须换代：同键不同内容会被服务端按 `IDEMPOTENCY_CONFLICT` 拒绝，用户拿到的会是
  // 「创建失败」而不是他刚改过的那条工单。标题与正文任一变化都属于「内容变化」。
  test("标题或正文变化后幂等键换代", () => {
    let counter = 0;
    const holder = createIdempotencyKeyHolder(() => {
      counter += 1;
      return `key-${counter}`;
    });

    const base = holder.take(ticketFormSignature({ title: "标题", body: "正文" }));
    const titleChanged = holder.take(ticketFormSignature({ title: "标题（改）", body: "正文" }));
    const bodyChanged = holder.take(ticketFormSignature({ title: "标题（改）", body: "正文（改）" }));

    expect(base).toBe("key-1");
    expect([titleChanged, bodyChanged]).toEqual(["key-2", "key-3"]);
    // 回到原内容也不再复用旧键：持有者只记「最近一次提交」，旧键已随那次提交发出，
    // 再次提交同内容是一次新的用户动作（服务端按最新内容去重）。
    expect(holder.take(ticketFormSignature({ title: "标题（改）", body: "正文（改）" }))).toBe("key-3");
  });

  // 指纹只覆盖参与幂等语义的字段：正文缺省与空串必须同形，否则「只填标题」的表单在两次提交间
  // 会因为 `undefined` / `""` 的写法差异被判成内容变化，白白丢掉服务端的去重机会。
  test("内容指纹对正文缺省与空串同形，且随首尾空格变化", () => {
    expect(ticketFormSignature({ title: "标题" })).toBe(ticketFormSignature({ title: "标题", body: "" }));
    expect(ticketFormSignature({ title: "标题", body: "正文" })).not.toBe(
      ticketFormSignature({ title: "标题 ", body: "正文" }),
    );
  });
});

describe("创建表单的校验规则", () => {
  // 正文是后端必填（`TicketCreateRequestSchema` 的 `body: min(1)`）：空描述必须在客户端被 schema 拦下，
  // 错误行取的是**字典键**（`validation.bodyRequired`），界面才能按语言渲染「请填写描述」。
  test("正文为空被 schema 拦下且错误指向 validation.bodyRequired", () => {
    const parsed = ticketFormSchema.safeParse({ title: "标题", body: "" });
    expect(parsed.success).toBe(false);
    const message = parsed.success ? undefined : parsed.error.issues[0]?.message;
    expect(message).toBe("validation.bodyRequired");
    // 只有第一个 issue 可能是空的：下面用标题为空的用例自检扫描真的落在正文字段上。
    const bodyIssue = parsed.success ? undefined : parsed.error.issues.find((issue) => issue.path[0] === "body");
    expect(bodyIssue?.message).toBe("validation.bodyRequired");
  });

  // 自检：标题同样必填且键不同——两条规则若被写成同一条，用户会收到与字段无关的提示。
  test("标题为空被 schema 拦下且错误指向 validation.titleRequired", () => {
    const parsed = ticketFormSchema.safeParse({ title: "   ", body: "正文" });
    expect(parsed.success).toBe(false);
    const titleIssue = parsed.success ? undefined : parsed.error.issues.find((issue) => issue.path[0] === "title");
    expect(titleIssue?.message).toBe("validation.titleRequired");
  });

  // 合法输入必须通过：校验规则过严会把正常的工单挡在客户端。
  test("标题与正文都非空时通过校验", () => {
    const parsed = ticketFormSchema.safeParse({ title: "登录后跳转空白页", body: "复现步骤……" });
    expect(parsed.success).toBe(true);
  });
});

// ── 创建请求的形状与两种响应落点：替换 fetch 观察真实的 `ticketApi.create` ──
type StubResponse = { status: number; body: unknown };
type RecordedCall = { url: string; method: string; idempotencyKey: string | null; body: unknown };

/** 替换 fetch 并记录请求；恢复函数在用例结束时调用。 */
function stubFetch(response: StubResponse): { calls: RecordedCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: String(response.status),
      headers: new Map([["content-type", "application/json"]]),
      json: async () => response.body,
      text: async () => JSON.stringify(response.body),
    } as unknown as Response;
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

describe("创建请求形状与响应落点", () => {
  const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
  const CREATE_BODY = { title: "登录后跳转空白页", body: "复现步骤……" };

  // 幂等键的载体是 `Idempotency-Key` 请求头（服务端的去重账本按它认回同一个操作）：键生成得再对，
  // 头没带上就等于每次重试都是新操作。这条同时钉住 POST 路径与 JSON 请求体。
  test("create 以 POST + JSON 请求体发出，并带上 Idempotency-Key 头", async () => {
    const { calls, restore } = stubFetch({
      status: 201,
      body: { success: true, data: { ticket: ticketDto(), operationId: "op-1" } },
    });
    try {
      await ticketApi.create(PROJECT_ID, CREATE_BODY, "key-abc-123");
    } finally {
      restore();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe(`/web/tickets/${PROJECT_ID}`);
    expect(calls[0]?.idempotencyKey).toBe("key-abc-123");
    expect(calls[0]?.body).toEqual(CREATE_BODY);
  });

  // 201：工单已建。响应体里的 `ticket` 由域模块回填请求上下文里的 `projectId`——行内链接必须用它，
  // 否则默认项目切换后同一个工单号会指向另一个仓库；`issueNumber` 全程按字符串承载。
  test("201 回填 projectId 并原样保留 operationId", async () => {
    const { restore } = stubFetch({
      status: 201,
      body: { success: true, data: { ticket: ticketDto(), operationId: "op-2" } },
    });
    let result: TicketCreateResult | undefined;
    try {
      const response = await ticketApi.create(PROJECT_ID, CREATE_BODY, "key-abc-123");
      expect(response.success).toBe(true);
      result = response.data;
    } finally {
      restore();
    }

    if (result === undefined || !("ticket" in result)) throw new Error("201 响应未被解包成工单本体");
    expect(result.operationId).toBe("op-2");
    expect(result.ticket.projectId).toBe(PROJECT_ID);
    expect(result.ticket.issueNumber).toBe("42");
    expect(isUncertainAccepted(result)).toBe(false);
  });

  // 202：上游写入结果未定，响应体**没有** ticket 字段。调用方必须经判别函数把它认成「受理」而不是
  // 「已创建」——抢跑会把用户送到一个索引里还不存在的工单上。
  test("202 解包为受理体且被判为待确认（不带工单本体）", async () => {
    const { restore } = stubFetch({
      status: 202,
      body: { success: true, data: { operationId: "op-3", status: "uncertain" } },
    });
    let result: TicketCreateResult | undefined;
    try {
      const response = await ticketApi.create(PROJECT_ID, CREATE_BODY, "key-abc-123");
      expect(response.success).toBe(true);
      result = response.data;
    } finally {
      restore();
    }

    expect(isUncertainAccepted(result as TicketCreateResult)).toBe(true);
    expect(result).toEqual({ operationId: "op-3", status: "uncertain" });
    expect(result !== undefined && "ticket" in result).toBe(false);
  });
});

/** 后端 `TicketDetailViewSchema` 的工单本体（不含前端回填的 `projectId`、不含正文）。 */
function ticketDto() {
  return {
    issueNumber: "42",
    title: "登录后跳转空白页",
    state: "open",
    author: { id: "user-1", name: "张三", source: "aos" },
    assignee: null,
    labels: [],
    version: "v1",
    providerUpdatedAt: "2026-10-12T08:00:00.000Z",
    syncedAt: "2026-10-12T08:00:01.000Z",
    syncStatus: "ready",
    body: "复现步骤……",
    // 无在途写：创建响应同样是详情视图，待确认的载体字段必须存在于夹具里（写它的人不会漏）。
    pendingOperationId: null,
  };
}
