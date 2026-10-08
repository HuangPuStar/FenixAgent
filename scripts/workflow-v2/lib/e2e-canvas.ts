/**
 * 画布端到端联调（1J）的画布链路：票据兑换与三条判据的探测体。
 *
 * 全部请求走 `/workflow-canvas/bff/*`（上游原生 `{data, code, msg}` + 原样 HTTP 状态），携带
 * `X-Fenix-Workflow-Ticket`。三条判据对应本文件的三个 `runCriterion*`：
 *
 * - A 打开 → 编辑 → 保存：canvas 读取（**不传 space_id**，服务端必须自行注入）→ 改写节点标题 →
 *   `save` 草稿 → 复读校验标题确实落库 → 发布记录读接口；复用既有 workflow 时最后把原始 schema 写回。
 * - B 伪造参数被覆盖：带全部客户端自报字段（`space_id`/`project_id`/`bot_id`/`owner_id`/
 *   `login_user_create`/`creator`/`operator`）调用两个**会回显 project_id** 的读接口，断言伪造值一个都没
 *   回来、且回显的 `project_id` 等于本地绑定里的租户 App ID。
 * - C 跨租户 404：组织 A 的票据访问组织 B 的真实 workflow → 404 `not_found`，并与「不存在的 workflow」
 *   的响应**逐字相同**（不泄漏存在性）；另做一次「无票据 → 401」的对照，证明 404 不是「什么都 404」。
 *
 * 未覆盖（诚实声明，见 README「未验证项」）：`creator`/`operator`/`owner_id`/`login_user_create` 在上游没有
 * 语义位点，服务端只做 strip、没有可回显的权威值，因此对这四个字段只能断言「未出现在响应里」，不能证明
 * 「上游一定没收到」；调试类读接口（`get_process` / `get_node_execute_history`）需要真实 execute_id 或节点
 * 执行记录，本脚本不触发调试运行（会产生运行数据），因此改以发布记录读接口覆盖「调试/发布相关的读接口」。
 */

import { issueCode } from "./e2e-console";
import {
  type E2eContext,
  type E2eResponse,
  GROUP_A,
  GROUP_B,
  GROUP_C,
  recordInfo,
  runStep,
  type StepSpec,
  stepOutcome,
} from "./e2e-core";
import {
  applySchemaMarker,
  findValuePaths,
  judgeBffFailure,
  judgeIndistinguishable,
  judgeUpstreamSuccess,
  readNodeTitle,
  toEvidence,
  type Verdict,
} from "./e2e-logic";
import { pick } from "./probe-core";

/** 画布透传面的实例前缀（与 BFF 实例前缀一致；上游路径 = 去掉该前缀后的部分）。 */
const BFF_PREFIX = "/workflow-canvas/bff";

/** 判据 A/B/C 各自用到的上游端点（全部在透传白名单的三条前缀之内）。 */
const UPSTREAM = {
  canvas: "/api/workflow_api/canvas",
  save: "/api/workflow_api/save",
  workflowDetail: "/api/workflow_api/workflow_detail",
  publishList: "/api/workflow_api/list_publish_workflow",
} as const;

/** 客户端自报字段的伪造值：字段名取自冻结 §6 的注入白名单，值是带运行标记的哨兵串。 */
export interface ForgedFields {
  readonly fields: Record<string, string>;
  readonly values: readonly string[];
}

export function buildForgedFields(runId: string): ForgedFields {
  const fields: Record<string, string> = {
    space_id: `forged-space-${runId}`,
    project_id: `forged-project-${runId}`,
    bot_id: `forged-bot-${runId}`,
    owner_id: `forged-owner-${runId}`,
    login_user_create: `forged-login-user-${runId}`,
    creator: `forged-creator-${runId}`,
    operator: `forged-operator-${runId}`,
  };
  return { fields, values: Object.values(fields) };
}

export interface CanvasSubject {
  readonly upstreamWorkflowId: string;
  /**
   * 服务端会注入的 `project_id` / `bot_id` 权威值（组织的租户 App ID，控制台面读出）。
   *
   * 只带 `project_id` 不带 `space_id`：上游没有任何接口回显 `space_id`，它只能靠「请求成功 + 伪造值未
   * 回显」间接证明（若服务端没注入空间 ID，`canvas` 会得到上游的缺参错误）。
   */
  readonly realAppId: string;
  /** 编辑标记：附加到节点标题尾部，用于证明「编辑确实落库」。 */
  readonly marker: string;
  /** 复用既有 workflow 时置 true：结束时把开头读到的原始 schema 写回（不留下测试痕迹）。 */
  readonly restoreOriginal: boolean;
}

/** 上游路径 → 本面路径（透传面的路径就是 BFF 前缀 + 上游路径）。 */
function bffPath(upstreamPath: string): string {
  return `${BFF_PREFIX}${upstreamPath}`;
}

/** 取响应里 `data.workflow.schema_json`（canvas 的成功形状）。 */
function readSchemaJson(response: E2eResponse): string | null {
  const schema = pick(response.json, ["data", "workflow", "schema_json"]);
  return typeof schema === "string" && schema.length > 0 ? schema : null;
}

/** 一次带票据的透传调用；票据只在请求头里流转，不进证据。 */
async function passthrough(
  context: E2eContext,
  input: {
    id: string;
    group: string;
    title: string;
    path: string;
    method: "GET" | "POST";
    ticket: string;
    body?: unknown;
    query?: Record<string, string>;
    judge: StepSpec["judge"];
    evidence?: StepSpec["evidence"];
  },
): Promise<E2eResponse> {
  return runStep(context, {
    id: input.id,
    group: input.group,
    title: input.title,
    request: {
      method: input.method,
      path: bffPath(input.path),
      body: input.body,
      query: input.query,
      ticket: input.ticket,
    },
    judge: input.judge,
    evidence: input.evidence,
  });
}

/**
 * 兑换一次性 code 换票据（`POST /workflow-canvas/bff/session/exchange`，本面唯一免票端点）。
 *
 * 断言 `claims.wf` 与受测 workflow 逐字一致：票据绑定错了对象，后面每条透传请求都会因为「显式身份与票据
 * 不一致」得到 404，那种失败看起来像归属问题、实际是签发问题——在这里先把它挡住。
 */
export async function exchangeTicket(
  context: E2eContext,
  input: { code: string; workflowId: string; id: string; group: string; title: string },
): Promise<string | null> {
  const response = await runStep(context, {
    id: input.id,
    group: input.group,
    title: input.title,
    request: { method: "POST", path: bffPath("/session/exchange"), body: { code: input.code } },
    judge: (res) => {
      const base = judgeUpstreamSuccess(res.httpStatus, res.json);
      if (!base.ok) return base;
      const ticket = pick(res.json, ["data", "ticket"]);
      const claims = pick(res.json, ["data", "claims"]);
      const boundWorkflow = pick(claims, ["wf"]);
      const expected = `HTTP 2xx + { code: 0, data: { ticket, claims.wf: "${input.workflowId}" } }`;
      const actual = `HTTP ${res.httpStatus ?? "-"}，ticket=${typeof ticket === "string" ? "<已取得>" : "<缺失>"}，claims.wf=${String(boundWorkflow ?? "-")}`;
      if (typeof ticket !== "string" || ticket.length === 0) {
        return { ok: false, expected, actual, suggestion: "兑换未返回 ticket：确认 code 未被消费过（60s 内单次有效）" };
      }
      if (boundWorkflow !== input.workflowId) {
        return {
          ok: false,
          expected,
          actual,
          suggestion: "票据绑定的 workflow 与请求对象不一致：核对 iframe-code 的 workflowId 入参",
        };
      }
      return { ok: true, expected, actual, suggestion: null };
    },
    evidence: (res) => `claims=${toEvidence(pick(res.json, ["data", "claims"]))}（票据只留在内存，不落报告）`,
  });
  const ticket = pick(response.json, ["data", "ticket"]);
  return typeof ticket === "string" && ticket.length > 0 ? ticket : null;
}

/** 判据 A：打开 → 编辑 → 保存（含发布记录读接口；复用模式下最后写回原始 schema）。 */
export async function runCriterionOpenEditSave(
  context: E2eContext,
  ticket: string,
  subject: CanvasSubject,
): Promise<void> {
  const opened = await passthrough(context, {
    id: "A2",
    group: GROUP_A,
    title: "拉取画布（打开）",
    path: UPSTREAM.canvas,
    method: "POST",
    ticket,
    // 刻意不传 space_id：客户端本可以塞一个（画布 URL 里就有），而服务端必须自行注入权威值。
    body: { workflow_id: subject.upstreamWorkflowId },
    judge: (res) => {
      const base = judgeUpstreamSuccess(res.httpStatus, res.json);
      if (!base.ok) return base;
      if (readSchemaJson(res) === null) {
        return {
          ok: false,
          expected: "HTTP 2xx + { code: 0, data.workflow.schema_json: <非空字符串> }",
          actual: `${base.actual}，data.workflow.schema_json 缺失或为空`,
          suggestion: "上游返回成功但 schema 缺失：核对上游版本与契约快照 §2 第 7 行",
        };
      }
      return base;
    },
    evidence: (res) => {
      const schema = readSchemaJson(res) ?? "";
      const nodes = (() => {
        try {
          const parsed: unknown = JSON.parse(schema);
          return Array.isArray(pick(parsed, ["nodes"])) ? (pick(parsed, ["nodes"]) as unknown[]).length : 0;
        } catch {
          return 0;
        }
      })();
      return `节点 ${nodes} 个，schema ${schema.length} 字符，project_id=${String(pick(res.json, ["data", "workflow", "project_id"]) ?? "-")}`;
    },
  });

  // 先收紧 schema 的 null（判据 A 的「编辑」没有 schema 就无从谈起），再谈编辑本身。
  const schemaText = readSchemaJson(opened);
  if (schemaText === null) {
    recordInfo(context, {
      id: "A3",
      group: GROUP_A,
      title: "编辑草稿（改写节点标题）",
      outcome: "fail",
      actual: "画布响应里没有可用的 schema_json，无法编辑",
      suggestion: "确认该 workflow 已正确创建；契约漂移时先比对契约快照 §2 第 7 行",
    });
    return;
  }
  const edit = applySchemaMarker(schemaText, subject.marker);
  if (edit.nodeId === null || edit.after === null) {
    recordInfo(context, {
      id: "A3",
      group: GROUP_A,
      title: "编辑草稿（改写节点标题）",
      outcome: "fail",
      actual: edit.detail,
      suggestion: "确认该 workflow 的 schema 里有带 id/data 的节点；契约漂移时先比对契约快照 §2 第 7 行",
    });
    return;
  }
  recordInfo(context, {
    id: "A3",
    group: GROUP_A,
    title: "编辑草稿（改写节点标题）",
    outcome: "pass",
    actual: edit.detail,
  });

  const saved = await passthrough(context, {
    id: "A4",
    group: GROUP_A,
    title: "保存草稿（save）",
    path: UPSTREAM.save,
    method: "POST",
    ticket,
    // submit_commit_id 无输入时传空串（契约快照 §2 第 8 行：字段不可省，缺 schema 或该字段都会失败）。
    body: { workflow_id: subject.upstreamWorkflowId, submit_commit_id: "", schema: edit.schema },
    judge: (res) => judgeUpstreamSuccess(res.httpStatus, res.json),
    evidence: () => edit.detail,
  });
  const savedCode = pick(saved.json, ["code"]);
  if (saved.httpStatus === null || saved.httpStatus >= 400 || savedCode !== 0) return;

  await passthrough(context, {
    id: "A5",
    group: GROUP_A,
    title: "复读画布（校验编辑已落库）",
    path: UPSTREAM.canvas,
    method: "POST",
    ticket,
    body: { workflow_id: subject.upstreamWorkflowId },
    judge: (res) => {
      const base = judgeUpstreamSuccess(res.httpStatus, res.json);
      if (!base.ok) return base;
      const schema = readSchemaJson(res);
      const title = schema === null ? null : readNodeTitle(schema, edit.nodeId ?? "");
      const expected = `回读的节点标题等于保存前的改写值 "${edit.after}"`;
      const actual = `回读节点 ${edit.nodeId} 标题="${title ?? "<未取到>"}"`;
      if (title !== edit.after) {
        return {
          ok: false,
          expected,
          actual,
          suggestion: "保存返回成功但回读不一致：确认保存的是同一个 workflow_id，并检查上游是否有草稿缓存",
        };
      }
      return { ok: true, expected, actual, suggestion: null };
    },
  });

  await passthrough(context, {
    id: "A6",
    group: GROUP_A,
    title: "读取发布记录（发布相关读接口）",
    path: UPSTREAM.publishList,
    method: "POST",
    ticket,
    // size 必填（契约快照 §2 第 22 行）；space_id 由服务端注入，空态是 data:null 而不是空数组。
    body: { size: 20 },
    judge: (res) => judgeUpstreamSuccess(res.httpStatus, res.json),
    evidence: (res) => `data=${toEvidence(pick(res.json, ["data"]))}`,
  });

  if (subject.restoreOriginal) {
    await passthrough(context, {
      id: "A7",
      group: GROUP_A,
      title: "写回原始 schema（仅复用既有 workflow 时）",
      path: UPSTREAM.save,
      method: "POST",
      ticket,
      body: { workflow_id: subject.upstreamWorkflowId, submit_commit_id: "", schema: schemaText },
      judge: (res) => judgeUpstreamSuccess(res.httpStatus, res.json),
      evidence: () => `已把本次运行开头读到的原始 schema（${schemaText.length} 字符）写回，不留测试痕迹`,
    });
  }
}

/** 判据 B：客户端自报的 space/project/bot/owner/creator/operator 一律被服务端覆盖或剥离。 */
export async function runCriterionInjection(
  context: E2eContext,
  ticket: string,
  subject: CanvasSubject,
  forged: ForgedFields,
): Promise<void> {
  const canvasProbe = await passthrough(context, {
    id: "B1",
    group: GROUP_B,
    title: "带全部伪造字段拉画布",
    path: UPSTREAM.canvas,
    method: "POST",
    ticket,
    body: { workflow_id: subject.upstreamWorkflowId, ...forged.fields },
    judge: (res) => {
      const base = judgeUpstreamSuccess(res.httpStatus, res.json);
      if (!base.ok) return base;
      const echoed = pick(res.json, ["data", "workflow", "project_id"]);
      const expected = `HTTP 2xx + { code: 0 }，且回显 project_id 不是伪造值（权威值 ${subject.realAppId}）`;
      const actual = `HTTP ${res.httpStatus ?? "-"}，回显 project_id=${String(echoed ?? "<无>")}`;
      if (echoed === forged.fields.project_id) {
        return {
          ok: false,
          expected,
          actual,
          suggestion: "上游拿到了客户端自报的 project_id：注入白名单没有生效，检查 buildUpstreamBody 的 strip 顺序",
        };
      }
      return { ok: true, expected, actual, suggestion: null };
    },
    evidence: (res) => `回显 project_id=${String(pick(res.json, ["data", "workflow", "project_id"]) ?? "-")}`,
  });

  const detailProbe = await passthrough(context, {
    id: "B2",
    group: GROUP_B,
    title: "带全部伪造字段查 workflow 详情",
    path: UPSTREAM.workflowDetail,
    method: "POST",
    ticket,
    // workflow_detail 是唯一能批量回显 project_id 的入口（契约快照 §2 第 25 行）：权威值是否写入可在这里直接看。
    body: { workflow_ids: [subject.upstreamWorkflowId], ...forged.fields },
    judge: (res) => {
      const base = judgeUpstreamSuccess(res.httpStatus, res.json);
      if (!base.ok) return base;
      const items = pick(res.json, ["data"]);
      const first = Array.isArray(items) ? items[0] : null;
      const echoed = pick(first, ["project_id"]);
      const expected = `HTTP 2xx + { code: 0 }，且 data[0].project_id 等于本地绑定的租户 App（${subject.realAppId}）`;
      const actual = `HTTP ${res.httpStatus ?? "-"}，data[0].project_id=${String(echoed ?? "<无>")}`;
      if (echoed !== subject.realAppId) {
        return {
          ok: false,
          expected,
          actual,
          suggestion:
            "回显的 project_id 不是本地绑定值：确认该 workflow 确实挂在当前组织的 App 下（GET /web/workflow-v2/org-app 与列表项的 appId）",
        };
      }
      return { ok: true, expected, actual, suggestion: null };
    },
    evidence: (res) => {
      const items = pick(res.json, ["data"]);
      const first = Array.isArray(items) ? items[0] : null;
      return `回显 project_id=${String(pick(first, ["project_id"]) ?? "-")}，name=${String(pick(first, ["name"]) ?? "-")}`;
    },
  });

  // 两个响应体一起扫：只要有一处回显伪造值，就说明客户端自报值真的到了上游（不是「恰好没被看见」）。
  const hits = [...findValuePaths(canvasProbe.json, forged.values), ...findValuePaths(detailProbe.json, forged.values)];
  recordInfo(context, {
    id: "B3",
    group: GROUP_B,
    title: "伪造值未回显（strip 断言）",
    outcome: hits.length === 0 ? "pass" : "fail",
    actual:
      hits.length === 0
        ? `两次响应中均未出现伪造的 ${Object.keys(forged.fields).join(" / ")}（哨兵值 ${forged.values.length} 个）`
        : `响应里出现了伪造值：${hits.join("；")}`,
    suggestion:
      hits.length === 0
        ? null
        : "客户端自报字段没有被剥离：检查 CLIENT_SUPPLIED_FIELDS 与 buildUpstreamBody/buildUpstreamQuery",
  });
}

/**
 * 签发 code 并立刻兑换成票据（两条账目各自登记：`issueId` / `exchangeId`）。
 *
 * code 与票据都不进报告——签发与兑换各自只留「是否取得」与 claims（claims 里没有凭据材料）。
 */
export async function mintTicket(
  context: E2eContext,
  input: { cookie: string; workflowId: string; group: string; issueId: string; exchangeId: string; title: string },
): Promise<string | null> {
  const code = await issueCode(context, {
    cookie: input.cookie,
    workflowId: input.workflowId,
    id: input.issueId,
    group: input.group,
    title: `签发一次性 code（${input.title}）`,
  });
  if (code === null) return null;
  return exchangeTicket(context, {
    code,
    workflowId: input.workflowId,
    id: input.exchangeId,
    group: input.group,
    title: `兑换画布票据（${input.title}）`,
  });
}

/**
 * 判据 C：组织 A 的票据访问组织 B 的真实 workflow → 404，且与「不存在」同形。
 *
 * 三条账目分开记，是因为三种失败的处置完全不同：跨租户 404 不符（归属门没拦住）要比对注册表查询；同形比较
 * 不符（两个 404 形状不同）是泄漏面；401 对照不符说明票据门根本没在工作、前面的 404 结论也就不成立。
 */
export async function runCriterionCrossTenant(
  context: E2eContext,
  input: { cookie: string; ticket: string; foreignWorkflowId: string; foreignLabel: string },
): Promise<void> {
  const foreign = await passthrough(context, {
    id: "C4",
    group: GROUP_C,
    title: `组织 A 的票据访问组织 B 的 workflow（${input.foreignLabel}）`,
    path: UPSTREAM.canvas,
    method: "POST",
    ticket: input.ticket,
    body: { workflow_id: input.foreignWorkflowId },
    judge: (res) => judgeBffFailure(res.httpStatus, res.json, { status: 404, msg: "not_found" }),
  });

  // 不存在的 workflow 用一个 19 位数字串（与上游的 workflow_id 同形），确保走的是同一条字符串比较路径。
  const missingId = String(Date.now()) + String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  const missingTicket = await mintTicket(context, {
    cookie: input.cookie,
    workflowId: missingId,
    group: GROUP_C,
    issueId: "C5",
    exchangeId: "C6",
    title: "对照：不存在的 workflow",
  });
  if (missingTicket === null) {
    recordInfo(context, {
      id: "C7",
      group: GROUP_C,
      title: "两种 404 不可区分（不泄漏存在性）",
      outcome: "skip",
      actual: "对照票据未取得（code 签发或兑换失败），跳过同形比较",
    });
    return;
  }

  const missing = await passthrough(context, {
    id: "C7",
    group: GROUP_C,
    title: "访问不存在的 workflow",
    path: UPSTREAM.canvas,
    method: "POST",
    ticket: missingTicket,
    body: { workflow_id: missingId },
    judge: (res) => judgeBffFailure(res.httpStatus, res.json, { status: 404, msg: "not_found" }),
  });

  // 只有两条 404 都成立时，同形比较才有意义：否则比的是两个「都不是 404」的响应，结论会误导。
  if (stepOutcome(context, "C4") !== "pass" || stepOutcome(context, "C7") !== "pass") {
    recordInfo(context, {
      id: "C8",
      group: GROUP_C,
      title: "两种 404 不可区分（不泄漏存在性）",
      outcome: "skip",
      actual: "上一步的 404 未成立，同形比较的前提不具备",
    });
    return;
  }
  const comparison: Verdict = judgeIndistinguishable(foreign.json, missing.json, {
    left: "跨租户 404",
    right: "不存在 404",
  });
  recordInfo(context, {
    id: "C8",
    group: GROUP_C,
    title: "两种 404 不可区分（不泄漏存在性）",
    outcome: comparison.ok ? "pass" : "fail",
    actual: comparison.actual,
    suggestion: comparison.suggestion,
  });

  // 对照：无票据必须是真实 HTTP 401 + ticket_invalid（画布据此换票），否则 404 可能只是「什么都拒绝」。
  await passthrough(context, {
    id: "C9",
    group: GROUP_C,
    title: "对照：无票据 → 401",
    path: UPSTREAM.canvas,
    method: "POST",
    ticket: "",
    body: { workflow_id: input.foreignWorkflowId },
    judge: (res) => judgeBffFailure(res.httpStatus, res.json, { status: 401, msg: "ticket_invalid" }),
  });
}
