/**
 * 画布端到端联调（1J）的运行基建：HTTP 出口、步骤登记与报告输出。
 *
 * 与入口 `../canvas-e2e-check.ts`、判读逻辑 `e2e-logic.ts`、两条链路 `e2e-console.ts` / `e2e-canvas.ts`
 * 共同工作；按「纯逻辑 / 运行基建 / 链路步骤 / 编排」拆分是为了守住单文件规模，与既有探针同一套划分。
 *
 * 三条硬约束落在本文件：
 * 1. **不静默失败**：请求未完成（超时、取消、DNS/连接错误）也返回结构化结果并在报告里判 FAIL，绝不吞异常。
 * 2. **可超时、可取消**：每个请求都有独立的 AbortController（超时 + 运行级信号合并），SIGINT 立即中止在飞请求。
 * 3. **凭据不外泄**：cookie / 票据只经参数传递，证据文本一律先过 `toEvidence`（脱敏 + 截断）。
 */

import { writeFile } from "node:fs/promises";
import {
  type E2eConfig,
  inspectConsoleEnvelope,
  inspectEnvelope,
  toEvidence,
  upstreamCarriedMessage,
  type Verdict,
} from "./e2e-logic";

/** 画布票据头名（冻结 §7；与 BFF 逐字一致，否则静默失效）。 */
export const TICKET_HEADER = "X-Fenix-Workflow-Ticket";
/** 多组织账号选择 active organization 的请求头（宿主 `services/org-context` 的解析顺序：header > query > cookie）。 */
export const ACTIVE_ORG_HEADER = "x-active-org-id";
/** 非 JSON 响应保留的原文长度上界（够看清是网关页还是纯文本 panic，又不至于灌满终端）。 */
const MAX_BODY_CHARS = 1_000;

export interface E2eResponse {
  /** `null` = 请求未完成（超时/取消/网络错误），此时 `error` 有值。 */
  readonly httpStatus: number | null;
  readonly json: unknown;
  readonly bodyText: string;
  /** 原始 `Set-Cookie`；**只供登录换会话**，绝不进报告。 */
  readonly setCookies: readonly string[];
  readonly error: string | null;
}

export interface E2eHttpConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly activeOrgId: string | null;
}

export interface E2eRequestInput {
  readonly method: "GET" | "POST" | "DELETE";
  /** 相对基址的路径，必须以 `/` 开头。 */
  readonly path: string;
  readonly query?: Record<string, string>;
  readonly body?: unknown;
  /** 控制台会话 cookie（整条 `name=value; name2=value2`）。 */
  readonly cookie?: string | null;
  /** 画布票据值（自动放进 `X-Fenix-Workflow-Ticket`）。 */
  readonly ticket?: string | null;
  /** 显式 Origin（带 cookie 的 better-auth 请求需要它通过 origin 校验）。 */
  readonly origin?: string | null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "TimeoutError"
      ? `${error.name}: 请求已中止`
      : `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * 单次请求出口：自带超时与取消。
 *
 * 超时用独立的定时器而不是 `AbortSignal.timeout`，是为了把「运行级取消」（SIGINT）与「本次超时」合并到
 * 同一个 controller 上——否则取消只能等超时到点才生效。
 */
export async function e2eRequest(input: E2eRequestInput, config: E2eHttpConfig): Promise<E2eResponse> {
  const url = new URL(input.path, config.baseUrl);
  for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, value);

  const headers: Record<string, string> = {};
  if (input.body !== undefined) headers["Content-Type"] = "application/json";
  if (input.cookie) headers.Cookie = input.cookie;
  if (input.ticket) headers[TICKET_HEADER] = input.ticket;
  if (input.origin) headers.Origin = input.origin;
  if (config.activeOrgId) headers[ACTIVE_ORG_HEADER] = config.activeOrgId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const forwardAbort = () => controller.abort();
  if (config.signal.aborted) controller.abort();
  else config.signal.addEventListener("abort", forwardAbort, { once: true });

  try {
    const response = await fetch(url, {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      // 非 JSON 响应（网关页、纯文本 panic）保持 undefined：判读会按「不是信封」处理，原文只进证据。
      json = undefined;
    }
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie") ?? ""].filter((item) => item.length > 0);
    return {
      httpStatus: response.status,
      json,
      bodyText: bodyText.slice(0, MAX_BODY_CHARS),
      setCookies,
      error: null,
    };
  } catch (error) {
    return { httpStatus: null, json: undefined, bodyText: "", setCookies: [], error: describeError(error) };
  } finally {
    clearTimeout(timer);
    config.signal.removeEventListener("abort", forwardAbort);
  }
}

// ── 步骤登记 ──

export type E2eOutcome = "pass" | "fail" | "skip";

export interface E2eRecord {
  readonly id: string;
  readonly group: string;
  readonly title: string;
  readonly outcome: E2eOutcome;
  readonly httpStatus: number | null;
  readonly code: number | null;
  readonly msg: string | null;
  readonly durationMs: number;
  readonly expected: string;
  readonly actual: string;
  readonly suggestion: string | null;
  readonly evidence: string | null;
}

export interface E2eContext {
  readonly config: E2eConfig;
  readonly http: E2eHttpConfig;
  readonly records: E2eRecord[];
  readonly startedAt: string;
  /** 控制台会话 cookie；只在内存里流转。 */
  cookie: string | null;
  /** 运行级中止信号（SIGINT 触发）；清理阶段用独立信号，不受它影响。 */
  readonly signal: AbortSignal;
  /** 置位后不再发起新请求（用户中断）。 */
  interrupted: boolean;
}

/** 运行分组名：与报告里的三段判据一一对应，另加前置与清理两组。 */
export const GROUP_PREP = "前置";
export const GROUP_A = "A 打开 → 编辑 → 保存";
export const GROUP_B = "B 伪造参数被覆盖";
export const GROUP_C = "C 跨租户 404";
export const GROUP_CLEANUP = "清理";

export interface StepSpec {
  readonly id: string;
  readonly group: string;
  readonly title: string;
  readonly request: E2eRequestInput;
  /** 判据：拿响应判 PASS/FAIL。抛异常按 FAIL 记（诊断上下文保留）。 */
  readonly judge: (response: E2eResponse) => Verdict;
  /** 追加证据（可选）；返回值会脱敏并截断。 */
  readonly evidence?: (response: E2eResponse) => string | null;
}

/** 报告里的 `code` 列只表达上游信封的业务码；控制台信封（`{success,data}`）没有对应物，留空。 */
function codeOf(json: unknown): number | null {
  const envelope = inspectEnvelope(json);
  return envelope.hasEnvelope ? envelope.code : null;
}

function msgOf(json: unknown): string | null {
  const envelope = inspectEnvelope(json);
  // 与 judgeUpstreamSuccess 同一口径：报告里的文案列也按 `msg` → `message` 取，否则成功的
  // `workflow_detail` 步会在报告里显示成「msg 为空」，看起来像判据没生效。
  if (envelope.hasEnvelope) return upstreamCarriedMessage(envelope);
  const consoleEnvelope = inspectConsoleEnvelope(json);
  return consoleEnvelope.errorMessage ?? (consoleEnvelope.success === true ? "success" : null);
}

/** 执行一步请求并按判据登记；无论判读结果如何都返回原始响应供后续步骤取数。 */
export async function runStep(context: E2eContext, spec: StepSpec): Promise<E2eResponse> {
  const startedAt = Date.now();
  const response = await e2eRequest(spec.request, context.http);
  let judged: Verdict;
  try {
    judged = spec.judge(response);
  } catch (error) {
    judged = {
      ok: false,
      expected: "判读过程本身不应抛异常",
      actual: `判读抛异常：${error instanceof Error ? error.message : String(error)}`,
      suggestion: "这是脚本缺陷：请把该步骤 id 与上游响应形状一并反馈",
    };
  }
  // 请求未完成时把网络诊断拼进 actual：超时/取消/连接失败的定位信息不能丢。
  const actual = response.error === null ? judged.actual : `${judged.actual}；请求未完成（${response.error}）`;
  context.records.push({
    id: spec.id,
    group: spec.group,
    title: spec.title,
    outcome: judged.ok ? "pass" : "fail",
    httpStatus: response.httpStatus,
    code: codeOf(response.json),
    msg: msgOf(response.json),
    durationMs: Date.now() - startedAt,
    expected: judged.expected,
    actual,
    suggestion: judged.ok ? null : judged.suggestion,
    evidence: spec.evidence ? toEvidence(spec.evidence(response)) : null,
  });
  return response;
}

/** 查某一步的结论（按 id）；未执行过返回 null。调用方据此区分「读到了 unbound」与「这一步根本没成功」。 */
export function stepOutcome(context: E2eContext, id: string): E2eOutcome | null {
  const record = context.records.find((item) => item.id === id);
  return record?.outcome ?? null;
}

/** 登记一条未执行的步骤（缺前置、缺资源等）：不计入失败，但会让退出码非 0。 */ export function recordSkip(
  context: E2eContext,
  input: { id: string; group: string; title: string; reason: string },
): void {
  context.records.push({
    id: input.id,
    group: input.group,
    title: input.title,
    outcome: "skip",
    httpStatus: null,
    code: null,
    msg: null,
    durationMs: 0,
    expected: "该步的前置条件齐备",
    actual: input.reason,
    suggestion: null,
    evidence: null,
  });
}

/** 登记一条纯信息（无请求）：用于记录自动完成的动作（如自动绑定），保持报告可追溯。 */
export function recordInfo(
  context: E2eContext,
  input: { id: string; group: string; title: string; outcome: E2eOutcome; actual: string; suggestion?: string | null },
): void {
  context.records.push({
    id: input.id,
    group: input.group,
    title: input.title,
    outcome: input.outcome,
    httpStatus: null,
    code: null,
    msg: null,
    durationMs: 0,
    expected: input.outcome === "skip" ? "该步的前置条件齐备" : "该步按预期完成",
    actual: input.actual,
    suggestion: input.suggestion ?? null,
    evidence: null,
  });
}

// ── 报告 ──

export interface E2eArgs {
  readonly json: boolean;
  readonly outPath: string | null;
}

export function parseArgs(argv: string[]): E2eArgs {
  let json = false;
  let outPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--out") outPath = argv[++index] ?? null;
    else {
      console.error(`未知参数：${arg}（可用：--json / --out <path>）`);
      process.exit(2);
    }
  }
  if (argv.includes("--out") && outPath === null) {
    console.error("--out 需要给出文件路径");
    process.exit(2);
  }
  return { json, outPath };
}

export interface E2eSummary {
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly skip: number;
}

export function summarize(records: readonly E2eRecord[]): E2eSummary {
  const fail = records.filter((record) => record.outcome === "fail").length;
  const skip = records.filter((record) => record.outcome === "skip").length;
  return { total: records.length, pass: records.length - fail - skip, fail, skip };
}

function printRecord(record: E2eRecord): void {
  const marker = record.outcome === "pass" ? "PASS" : record.outcome === "fail" ? "FAIL" : "SKIP";
  const status = `${record.httpStatus ?? "-"}/${record.code ?? "-"}`;
  console.log(
    `  ${marker} ${record.id.padEnd(6)} ${record.title.padEnd(30)} ${status.padEnd(9)} ${String(record.durationMs).padStart(6)}ms`,
  );
  console.log(`       ${record.actual.slice(0, 200)}`);
  if (record.evidence) console.log(`       证据：${record.evidence}`);
  if (record.outcome === "fail") {
    console.log(`       期望：${record.expected}`);
    if (record.suggestion) console.log(`       下一步建议：${record.suggestion}`);
  }
}

function printHumanReport(context: E2eContext, meta: E2eReportMeta): void {
  const summary = summarize(context.records);
  console.log("Workflow V2 画布端到端联调（任务 1J）");
  console.log(`  基址 ${context.config.baseUrl}`);
  console.log(`  会话 ${context.cookie === null ? "<未取得>" : "<已取得>"}（来源见下方提示）`);
  console.log(`  开始 ${context.startedAt}`);
  for (const line of meta.notes) console.log(`  说明 ${line}`);
  console.log(`  受测 workflow ${meta.subject} `);
  if (meta.facts.length > 0) {
    for (const fact of meta.facts) console.log(`  ${fact.label} ${fact.value}`);
  }
  for (const group of [...new Set(context.records.map((record) => record.group))]) {
    console.log(`\n[${group}]`);
    for (const record of context.records.filter((item) => item.group === group)) printRecord(record);
  }
  console.log(`\n汇总：PASS ${summary.pass}，FAIL ${summary.fail}，SKIP ${summary.skip}（共 ${summary.total} 步）`);
  if (meta.cleanup !== null) console.log(`清理：${meta.cleanup}`);
  const failed = context.records.filter((record) => record.outcome === "fail");
  if (failed.length > 0) {
    console.log("失败清单：");
    for (const record of failed) {
      console.log(`  - ${record.id} ${record.title}：${record.actual.slice(0, 160)}`);
      if (record.suggestion) console.log(`      建议：${record.suggestion}`);
    }
  }
  console.log(`退出码 ${meta.exitCode}：${meta.exitHint}`);
}

export interface E2eReportMeta {
  readonly notes: readonly string[];
  readonly subject: string;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  readonly cleanup: string | null;
  readonly exitCode: number;
  readonly exitHint: string;
}

/** 产出报告（人类可读或 `--json`）并按需落盘。 */
export async function report(context: E2eContext, args: E2eArgs, meta: E2eReportMeta): Promise<void> {
  const payload = {
    meta: {
      tool: "scripts/workflow-v2/canvas-e2e-check.ts",
      baseUrl: context.config.baseUrl,
      startedAt: context.startedAt,
      finishedAt: new Date().toISOString(),
      subject: meta.subject,
      facts: meta.facts,
      cleanup: meta.cleanup,
      exitCode: meta.exitCode,
    },
    summary: summarize(context.records),
    records: context.records,
  };
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else printHumanReport(context, meta);
  if (args.outPath) {
    await writeFile(args.outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    if (!args.json) console.log(`结构化结果已写入 ${args.outPath}`);
  }
}
