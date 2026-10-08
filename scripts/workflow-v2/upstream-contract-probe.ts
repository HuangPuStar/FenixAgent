/**
 * 上游契约快照探针（workflow-v2 阶段 0 基线）。
 *
 * 对上游工作流引擎 的 `/api/workflow_api/*` 与配套引导接口（passport / playground_api / draftbot）做一次
 * 可重复执行的探测，产出**脱敏**的结构化基线，作为上游升级后的回归依据 —— 采集结果落在
 * `docs/design/2026-09-29-workflow-v2-upstream-contract-snapshot.md`，接口范围依据
 * `docs/design/2026-09-29-workflow-v2-upstream-studio-bridge.md` §4.2 与
 * `docs/design/2026-09-29-workflow-v2-interface-freeze.md` §6。
 *
 * 配置只来自环境变量（源码内不出现任何密码或 token）：
 *   WORKFLOW_V2_PROBE_BASE_URL  上游基址，默认 `http://127.0.0.1:18080`
 *   WORKFLOW_V2_PROBE_EMAIL     探针账号邮箱，必填
 *   WORKFLOW_V2_PROBE_PASSWORD  探针账号密码，必填
 *
 * 用法：
 *   WORKFLOW_V2_PROBE_EMAIL=... WORKFLOW_V2_PROBE_PASSWORD=... \
 *     bun run scripts/workflow-v2/upstream-contract-probe.ts [--json] [--out <path>] [--state <path>]
 *
 * 参数：
 *   --json          机器可读结果输出到 stdout（默认输出人类可读摘要）
 *   --out <path>    结果额外写入文件（JSON）
 *   --state <path>  探针资源台账，默认 `$TMPDIR/fenix-workflow-v2-probe-state.json`
 *
 * 可重复执行：`draftbot/create` 每跑一次都会新增一个 App，而上游没有「按空间列出 App」的接口，
 * 因此探针把 `{baseUrl, email, spaceId, appId, workflowId}` 记在本地台账里，后续运行复用同一组资源
 * （复用路径下 `draftbot/create` 记为 skipped，另用 `get_draft_bot_info` 校验 App 仍在）。
 * 台账丢失只会多建一个探针 App，不影响正确性。
 *
 * 安全与数据边界：
 * - `session_key` 只出现在 `Set-Cookie`，且其 `domain` 带端口（非法 domain，cookie jar 会拒收），
 *   故这里手工解析 `Set-Cookie` 并用显式 `Cookie` 请求头回传；会话键不落盘、不进输出。
 * - 输出前统一脱敏：会话键、任意 URL 的查询串（签名参数）、Go 堆栈（含本机绝对路径）。
 * - 只创建探针自有资源（探针 App / 探针 workflow / 本次运行的一次性临时 workflow），且只删除本次
 *   运行创建的资源；不改动、不删除任何既有数据。
 * - 退出码只在「引导阶段失败」（拿不到会话、空间或探针资源）时为 1；接口级失败是本次快照要记录的
 *   事实，不影响退出码。
 *
 * 模块划分：采集基建 `lib/probe-core.ts`、共享常量 `lib/probe-shared.ts`、
 * 引导资源 `lib/probe-bootstrap.ts`、主链路套件 `lib/probe-workflow.ts`、
 * 辅助套件 `lib/probe-auxiliary.ts`。
 */

import { writeFile } from "node:fs/promises";
import { probeAuthShape, probeCleanup, probeNodePanel, probeReloginShape, probeTrace } from "./lib/probe-auxiliary";
import { resolveProbeResources } from "./lib/probe-bootstrap";
import {
  asString,
  DEFAULT_BASE_URL,
  describeShape,
  loadState,
  parseArgs,
  pick,
  post,
  probe,
  type RunContext,
  redactValue,
  saveState,
  sendRequest,
} from "./lib/probe-core";
import { probeCanvasAndSave, probeRun, probeVersion } from "./lib/probe-workflow";

/** 读取环境变量配置；缺必填项时给出可照抄的用法并以 1 退出。 */
function requireConfig(): { baseUrl: string; email: string; password: string } {
  const baseUrl = (process.env.WORKFLOW_V2_PROBE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const email = process.env.WORKFLOW_V2_PROBE_EMAIL;
  const password = process.env.WORKFLOW_V2_PROBE_PASSWORD;
  const missing = [email ? null : "WORKFLOW_V2_PROBE_EMAIL", password ? null : "WORKFLOW_V2_PROBE_PASSWORD"].filter(
    (item): item is string => item !== null,
  );
  if (missing.length > 0 || !email || !password) {
    console.error(`缺少必填环境变量：${missing.join("、")}`);
    console.error(
      "示例：WORKFLOW_V2_PROBE_EMAIL=probe@example.com WORKFLOW_V2_PROBE_PASSWORD=*** " +
        "bun run scripts/workflow-v2/upstream-contract-probe.ts",
    );
    console.error("密码只经环境变量传入，切勿写入源码或提交历史。");
    process.exit(1);
  }
  return { baseUrl, email, password };
}

/**
 * 登录并取回会话：登录失败（账号不存在）时回退注册。两条路径都只从 `Set-Cookie` 取 `session_key`，
 * 该值不在响应体里。
 */
async function login(context: RunContext, email: string, password: string): Promise<void> {
  const credentials = { email, password };
  const loginStartedAt = Date.now();
  const loginResponse = await sendRequest(
    { method: "POST", path: "/api/passport/web/email/login/", body: credentials, sessionKey: null },
    context.baseUrl,
  );
  context.records.push({
    id: "passport.login",
    group: "bootstrap",
    title: "平台账号登录",
    method: "POST",
    path: "/api/passport/web/email/login/",
    request: redactValue(credentials),
    httpStatus: loginResponse.httpStatus,
    businessCode: loginResponse.businessCode,
    msg: loginResponse.msg,
    outcome: loginResponse.httpStatus < 400 && loginResponse.setCookieTokens.length > 0 ? "ok" : "fail",
    durationMs: Date.now() - loginStartedAt,
    shape: loginResponse.json === undefined ? null : describeShape(loginResponse.json),
    note: `Set-Cookie 中提取 session_key：${loginResponse.setCookieTokens.length} 个`,
  });
  context.sessionKey = loginResponse.setCookieTokens[0] ?? null;
  if (context.sessionKey) return;

  const registerStartedAt = Date.now();
  const registerResponse = await sendRequest(
    { method: "POST", path: "/api/passport/web/email/register/v2/", body: credentials, sessionKey: null },
    context.baseUrl,
  );
  context.records.push({
    id: "passport.register",
    group: "bootstrap",
    title: "平台账号注册（登录无会话时回退）",
    method: "POST",
    path: "/api/passport/web/email/register/v2/",
    request: redactValue(credentials),
    httpStatus: registerResponse.httpStatus,
    businessCode: registerResponse.businessCode,
    msg: registerResponse.msg,
    outcome: registerResponse.httpStatus < 400 && registerResponse.setCookieTokens.length > 0 ? "ok" : "fail",
    durationMs: Date.now() - registerStartedAt,
    shape: registerResponse.json === undefined ? null : describeShape(registerResponse.json),
    note: `注册自动创建个人空间；Set-Cookie 会话数：${registerResponse.setCookieTokens.length}`,
  });
  context.sessionKey = registerResponse.setCookieTokens[0] ?? null;
}

function summarize(context: RunContext): { ok: number; failed: number; skipped: number } {
  const failed = context.records.filter((record) => record.outcome === "fail").length;
  const skipped = context.records.filter((record) => record.outcome === "skipped").length;
  return { ok: context.records.length - failed - skipped, failed, skipped };
}

/** 人类可读摘要：按分组逐条列出结论，末尾汇总失败清单。 */
function printHumanSummary(context: RunContext, startedAt: string): void {
  const { ok, failed, skipped } = summarize(context);
  console.log("上游契约快照探针");
  console.log(`  基址 ${context.baseUrl}`);
  console.log(`  账号 ${context.email}`);
  console.log(
    `  空间 ${context.spaceId || "<未知>"}  App ${context.appId || "<未知>"}  workflow ${context.workflowId || "<未知>"}`,
  );
  console.log(`  采集 ${startedAt} → ${new Date().toISOString()}`);
  for (const group of [...new Set(context.records.map((record) => record.group))]) {
    console.log(`\n[${group}]`);
    for (const record of context.records.filter((item) => item.group === group)) {
      const marker = record.outcome === "ok" ? "✓" : record.outcome === "fail" ? "✗" : "·";
      const status = `${record.httpStatus ?? "-"}/${record.businessCode ?? "-"}`;
      const message = record.msg ?? record.note ?? "";
      console.log(
        `  ${marker} ${record.id.padEnd(42)} ${status.padEnd(10)} ${String(record.durationMs).padStart(6)}ms  ${message.slice(0, 120)}`,
      );
    }
  }
  console.log(`\n汇总：探测 ${context.records.length} 项，成功 ${ok}，失败 ${failed}，跳过 ${skipped}`);
  if (failed > 0) {
    console.log("失败清单：");
    for (const record of context.records.filter((item) => item.outcome === "fail")) {
      console.log(`  - ${record.id}  http=${record.httpStatus} code=${record.businessCode} msg=${record.msg ?? ""}`);
    }
  }
}

/** 产出结果并按需落盘；返回退出码。 */
async function report(
  context: RunContext,
  args: { json: boolean; outPath: string | null },
  startedAt: string,
): Promise<number> {
  const payload = {
    meta: {
      tool: "scripts/workflow-v2/upstream-contract-probe.ts",
      baseUrl: context.baseUrl,
      email: context.email,
      startedAt,
      finishedAt: new Date().toISOString(),
      spaceId: context.spaceId || null,
      appId: context.appId || null,
      workflowId: context.workflowId || null,
    },
    summary: { total: context.records.length, ...summarize(context) },
    records: context.records,
  };
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else printHumanSummary(context, startedAt);
  if (args.outPath) {
    await writeFile(args.outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    if (!args.json) console.log(`\n结构化结果已写入 ${args.outPath}`);
  }
  return context.appId && context.workflowId ? 0 : 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { baseUrl, email, password } = requireConfig();
  const startedAt = new Date().toISOString();
  const context: RunContext = {
    baseUrl,
    email,
    sessionKey: null,
    spaceId: "",
    appId: "",
    workflowId: "",
    executeId: null,
    records: [],
  };

  await login(context, email, password);
  if (!context.sessionKey) {
    console.error("登录与注册均未返回 session_key，无法继续：请确认上游基址与探针账号配置。");
    process.exit(await report(context, args, startedAt));
  }

  const spaceRun = await probe(
    context,
    post(
      "playground_api.space_list",
      "bootstrap",
      "空间列表（个人空间是唯一 space）",
      "/api/playground_api/space/list",
      {
        body: {},
      },
    ),
  );
  context.spaceId = asString(pick(spaceRun.response?.json, ["data", "bot_space_list", "0", "id"])) ?? "";
  if (!context.spaceId) {
    console.error("空间列表未返回 data.bot_space_list[0].id，无法定位个人空间。");
    process.exit(await report(context, args, startedAt));
  }

  const state = await loadState(args.statePath);
  const reusable =
    state !== null && state.baseUrl === baseUrl && state.email === email && state.spaceId === context.spaceId;
  if (reusable && state) {
    context.appId = state.appId;
    context.workflowId = state.workflowId;
  }

  await resolveProbeResources(context, reusable);
  if (!context.appId || !context.workflowId) {
    console.error("未能准备探针 App / workflow，后续接口无法探测。");
    process.exit(await report(context, args, startedAt));
  }
  await saveState(args.statePath, {
    baseUrl,
    email,
    spaceId: context.spaceId,
    appId: context.appId,
    workflowId: context.workflowId,
    updatedAt: new Date().toISOString(),
  });

  await probeCanvasAndSave(context);
  await probeRun(context);
  await probeVersion(context);
  await probeNodePanel(context);
  await probeTrace(context);
  await probeAuthShape(context);
  await probeCleanup(context);
  await probeReloginShape(context, email, password);

  process.exit(await report(context, args, startedAt));
}

await main();
