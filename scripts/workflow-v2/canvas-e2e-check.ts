/**
 * 画布端到端联调（任务 1J）——**有凭据即可一键跑**的验收脚本。
 *
 * 逐项执行并给出 PASS/FAIL/SKIP + 证据，覆盖任务清单 1J 的三条判据：
 *   A 打开 → 编辑 → 保存（画布面真实路径：一次性 code → 票据兑换 → 透传 `/workflow-canvas/bff/*`）
 *   B 伪造 `space_id` / `project_id` / `bot_id` / `owner_id` / `login_user_create` / `creator` / `operator` 被服务端覆盖或 strip
 *   C 组织 A 的票据访问组织 B 的 workflow → 404，且与「不存在」的 404 逐字同形（不泄漏存在性）
 *
 * 配置只来自环境变量（源码内不出现任何凭据；密码/会话/票据只经内存流转，不进报告与日志）：
 *   WORKFLOW_V2_E2E_BASE_URL           平台服务基址，默认 `http://127.0.0.1:3000`
 *   WORKFLOW_V2_E2E_SESSION_COOKIE     控制台会话 cookie（浏览器复制）；与下面两项二选一
 *   WORKFLOW_V2_E2E_EMAIL              控制台账号邮箱（脚本自行登录）
 *   WORKFLOW_V2_E2E_PASSWORD           控制台账号密码
 *   WORKFLOW_V2_E2E_FOREIGN_WORKFLOW_ID 组织 B 名下的上游 workflow ID（判据 C 的对照）；与下两项二选一
 *   WORKFLOW_V2_E2E_EMAIL_B            组织 B 控制台账号（脚本登录后列出该组织的第一个 workflow）
 *   WORKFLOW_V2_E2E_PASSWORD_B         组织 B 控制台账号密码
 *   WORKFLOW_V2_E2E_WORKFLOW_ID        受测 workflow ID：给了就复用既有 workflow（不创建、不删除，编辑后写回还原）
 *   WORKFLOW_V2_E2E_ACTIVE_ORG_ID      多组织账号指定 active organization（经 `x-active-org-id` 下发）
 *   WORKFLOW_V2_E2E_TIMEOUT_MS         单请求超时，默认 15000
 *   WORKFLOW_V2_E2E_AUTO_BIND          组织未绑定时是否自动建绑（默认开；置 0/ false 关闭）
 *   WORKFLOW_V2_E2E_KEEP_RESOURCES     置 1 保留本次创建的临时 workflow（默认结束删除）
 *
 * 用法：
 *   WORKFLOW_V2_E2E_EMAIL=ops@example.com WORKFLOW_V2_E2E_PASSWORD=*** \
 *     bun run scripts/workflow-v2/canvas-e2e-check.ts [--json] [--out <path>]
 *
 * 退出码：0 = 三条判据全过；1 = 有 FAIL（含清理失败）；2 = 缺前置/缺凭据（判据没跑满）；130 = 用户中断。
 *
 * 可重复运行：临时 workflow 在结束时删除（`DELETE /web/workflow-v2/workflows/:id?force=true`，本地软删 +
 * 上游删除），脚本不依赖上一次运行的任何残留；组织未绑定时会补一次幂等建绑（上游侧建 App，不可回收，
 * 可用 WORKFLOW_V2_E2E_AUTO_BIND=0 关闭）。复用既有 workflow 时用「改写节点标题 → 保存 → 写回」的方式
 * 证明保存链路，不留测试痕迹。
 *
 * 模块划分：纯逻辑 `lib/e2e-logic.ts`、运行基建 `lib/e2e-core.ts`、控制台链路 `lib/e2e-console.ts`、
 * 画布链路 `lib/e2e-canvas.ts`；凭据与网络行为见各文件头部注释。
 */

import {
  buildForgedFields,
  type CanvasSubject,
  mintTicket,
  runCriterionCrossTenant,
  runCriterionInjection,
  runCriterionOpenEditSave,
} from "./lib/e2e-canvas";
import {
  bindOrgApp,
  type CreatedWorkflow,
  createWorkflow,
  deleteWorkflow,
  ensureSession,
  readOrgApp,
  readPlatformAccount,
  resolveForeignWorkflow,
} from "./lib/e2e-console";
import {
  type E2eContext,
  GROUP_A,
  GROUP_C,
  GROUP_PREP,
  parseArgs,
  recordInfo,
  recordSkip,
  report,
  stepOutcome,
} from "./lib/e2e-core";
import { type ConfigResolution, resolveConfig } from "./lib/e2e-logic";
import { pick } from "./lib/probe-core";

/** 运行态：跨越准备与三条判据的中间结果（cookie、临时资源、报告抬头）。 */
interface RunState {
  cookie: string | null;
  created: CreatedWorkflow | null;
  subjectLabel: string;
  readonly runId: string;
  readonly facts: { label: string; value: string }[];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 缺凭据/缺前置时立刻以非零码退出，并只列变量名与补法（绝不打印任何值）。 */
function printMissingPrerequisites(resolution: ConfigResolution): void {
  console.error("画布端到端联调无法开始：缺少必需配置。");
  for (const requirement of resolution.fatal) {
    console.error(`  - ${requirement.label}：缺 ${requirement.variables.join(" / ")}`);
    console.error(`    补法：${requirement.hint}`);
  }
  console.error("");
  console.error("密码与会话 cookie 只经环境变量传入，切勿写入源码或提交历史。示例：");
  console.error(
    "  WORKFLOW_V2_E2E_EMAIL=ops@example.com WORKFLOW_V2_E2E_PASSWORD=*** " +
      "bun run scripts/workflow-v2/canvas-e2e-check.ts",
  );
  console.error(
    "  （或）WORKFLOW_V2_E2E_SESSION_COOKIE='better-auth.session_token=***' " +
      "bun run scripts/workflow-v2/canvas-e2e-check.ts",
  );
}

/** SIGINT：中止在飞请求但仍走清理与报告（第二次 Ctrl+C 直接硬退出）。 */
function installSigint(context: E2eContext, controller: AbortController): void {
  let seen = 0;
  process.on("SIGINT", () => {
    seen += 1;
    if (seen > 1) {
      console.error("已再次收到中断信号，直接退出。");
      process.exit(130);
    }
    context.interrupted = true;
    console.error("\n收到中断信号：中止在飞请求，随后清理本次创建的临时资源…");
    controller.abort();
  });
}

/** 准备租户上下文：空间 ID（`space_id` 权威值）与租户 App ID（`project_id`/`bot_id` 权威值）。 */
async function prepareTenant(context: E2eContext, cookie: string): Promise<{ spaceId: string; appId: string } | null> {
  const account = await readPlatformAccount(context, { cookie, id: "P1" });
  const binding = await readOrgApp(context, { cookie, id: "P2" });
  let spaceId = readString(pick(account.json, ["data", "spaceId"]));
  let appId = readString(pick(binding.json, ["data", "appId"]));

  if (spaceId === null || appId === null) {
    // 只有「读成功但没有值」才是「未绑定」；读这一步本身失败（网络/500/401）时不能顺手去建绑——
    // 那会在服务不可用时反复发起建 App 的写请求，把一次瞬时故障变成一串上游副作用。
    if (stepOutcome(context, "P1") !== "pass" || stepOutcome(context, "P2") !== "pass") return null;
    const bound = await bindOrgApp(context, { cookie, id: "P3" });
    if (!bound) return null;
    const accountAfter = await readPlatformAccount(context, { cookie, id: "P4" });
    const bindingAfter = await readOrgApp(context, { cookie, id: "P5" });
    spaceId = readString(pick(accountAfter.json, ["data", "spaceId"]));
    appId = readString(pick(bindingAfter.json, ["data", "appId"]));
  }

  if (spaceId === null) {
    recordInfo(context, {
      id: "P6",
      group: GROUP_PREP,
      title: "平台账号空间投影",
      outcome: "fail",
      actual: "GET /web/workflow-v2/platform-account 的 spaceId 为 null（台账无行）",
      suggestion:
        "平台账号尚未引导：确认服务端已配置 WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL / PASSWORD 与 TICKET_SECRET，再调 " +
        "POST /web/workflow-v2/platform-account/login（重登）后重跑",
    });
    return null;
  }
  if (appId === null) {
    recordInfo(context, {
      id: "P6",
      group: GROUP_PREP,
      title: "租户 App 绑定",
      outcome: "fail",
      actual: "GET /web/workflow-v2/org-app 的 appId 为 null（该组织未绑定或绑定不可用）",
      suggestion: "在控制台点「初始化工作流空间」或允许脚本自动绑定（去掉 WORKFLOW_V2_E2E_AUTO_BIND=0）后重跑",
    });
    return null;
  }
  return { spaceId, appId };
}

/** 准备受测对象：默认创建临时 workflow（结束删除），给了 WORKFLOW_V2_E2E_WORKFLOW_ID 则复用既有。 */
async function prepareSubject(
  context: E2eContext,
  cookie: string,
  tenant: { spaceId: string; appId: string },
  runId: string,
): Promise<{ subject: CanvasSubject; created: CreatedWorkflow | null } | null> {
  const marker = ` (e2e-${runId})`;
  const preset = context.config.workflowId;
  if (preset) {
    recordInfo(context, {
      id: "P7",
      group: GROUP_PREP,
      title: "受测 workflow（环境变量）",
      outcome: "pass",
      actual: `复用 WORKFLOW_V2_E2E_WORKFLOW_ID=${preset}；不创建、不删除，编辑后写回原始 schema`,
    });
    return {
      subject: { upstreamWorkflowId: preset, realAppId: tenant.appId, marker, restoreOriginal: true },
      created: null,
    };
  }

  const name = `e2e-canvas-${runId}`;
  const created = await createWorkflow(context, { cookie, name, id: "P7" });
  if (created === null) return null;
  return {
    subject: {
      upstreamWorkflowId: created.upstreamWorkflowId,
      realAppId: tenant.appId,
      marker,
      restoreOriginal: false,
    },
    created,
  };
}

/** 判据 C 的准备：取一个属于别的组织的真实 workflow（缺前置时记 SKIP，不阻塞判据 A/B）。 */
async function resolveForeign(context: E2eContext): Promise<{ upstreamWorkflowId: string; name: string } | null> {
  const foreign = await resolveForeignWorkflow(context);
  if (foreign !== null) return foreign;
  recordSkip(context, {
    id: "C1",
    group: GROUP_C,
    title: "跨租户判据前置",
    reason:
      "没有可用的对照 workflow：给 WORKFLOW_V2_E2E_FOREIGN_WORKFLOW_ID（组织 B 名下的上游 workflow ID），" +
      "或给组织 B 的控制台账号（WORKFLOW_V2_E2E_EMAIL_B + WORKFLOW_V2_E2E_PASSWORD_B）——判据 C 未执行",
  });
  return null;
}

/** 主流程：准备 → A → B → C（任一步缺前置即停下，已记录的账目照常进报告）。 */
async function runPipeline(context: E2eContext, state: RunState): Promise<void> {
  const cookie = await ensureSession(context);
  if (cookie === null) return;
  state.cookie = cookie;
  // 同一份会话也写进运行上下文：报告头部据此显示「会话是否取得」，不需要在别处再存一次。
  context.cookie = cookie;

  const tenant = await prepareTenant(context, cookie);
  if (tenant === null) return;
  state.facts.push({ label: "空间 space_id（注入源）", value: tenant.spaceId });
  state.facts.push({ label: "租户 App project_id / bot_id（注入源）", value: tenant.appId });

  const prepared = await prepareSubject(context, cookie, tenant, state.runId);
  if (prepared === null) return;
  state.created = prepared.created;
  state.subjectLabel = prepared.created
    ? `${prepared.subject.upstreamWorkflowId}（本次创建：${prepared.created.name}；结束删除）`
    : `${prepared.subject.upstreamWorkflowId}（复用既有，不创建不删除）`;

  const ticket = await mintTicket(context, {
    cookie,
    workflowId: prepared.subject.upstreamWorkflowId,
    group: GROUP_A,
    issueId: "A0",
    exchangeId: "A1",
    title: "受测 workflow",
  });
  if (ticket === null) {
    recordSkip(context, {
      id: "A2",
      group: GROUP_A,
      title: "打开 → 编辑 → 保存",
      reason: "票据未取得（code 签发或兑换失败），判据 A 未执行",
    });
    return;
  }

  await runCriterionOpenEditSave(context, ticket, prepared.subject);
  await runCriterionInjection(context, ticket, prepared.subject, buildForgedFields(state.runId));

  const foreign = await resolveForeign(context);
  if (foreign === null) return;
  const foreignTicket = await mintTicket(context, {
    cookie,
    workflowId: foreign.upstreamWorkflowId,
    group: GROUP_C,
    issueId: "C2",
    exchangeId: "C3",
    title: `对照 workflow（${foreign.name}）`,
  });
  if (foreignTicket === null) {
    recordSkip(context, {
      id: "C4",
      group: GROUP_C,
      title: "组织 A 的票据访问组织 B 的 workflow",
      reason: "对照票据未取得（code 签发或兑换失败），判据 C 未执行",
    });
    return;
  }
  await runCriterionCrossTenant(context, {
    cookie,
    ticket: foreignTicket,
    foreignWorkflowId: foreign.upstreamWorkflowId,
    foreignLabel: foreign.name,
  });
}

/** 清理：删除本次创建的临时 workflow（复用模式与保留模式都不动上游）。 */
async function cleanup(context: E2eContext, state: RunState): Promise<string> {
  const created = state.created;
  if (created === null) {
    return context.config.workflowId ? "无需清理（复用既有 workflow，未创建任何资源）" : "无需清理（未创建资源）";
  }
  if (context.config.keepResources) {
    return `按要求保留临时 workflow ${created.upstreamWorkflowId}（WORKFLOW_V2_E2E_KEEP_RESOURCES=1；请自行在控制台删除）`;
  }
  if (state.cookie === null)
    return `临时 workflow ${created.upstreamWorkflowId} 未能删除（会话不可用），请在控制台手工删除`;

  // 清理用独立超时：运行级信号可能已被 SIGINT 中止，但清理必须照做。
  const deleted = await deleteWorkflow(context, state.cookie, created.localId);
  return deleted
    ? `已删除临时 workflow ${created.upstreamWorkflowId}（本地软删 + 上游删除；上游收敛失败时由对账任务重试）`
    : `临时 workflow ${created.upstreamWorkflowId} 删除未确认：请在控制台列表确认它已消失`;
}

/** 退出码语义：有 FAIL → 1；无 FAIL 但有 SKIP（缺前置）→ 2；全过 → 0；中断 → 130。 */
function computeExitCode(context: E2eContext, resolution: ConfigResolution): { code: number; hint: string } {
  if (context.interrupted) return { code: 130, hint: "运行被用户中断，结论不完整" };
  const failed = context.records.filter((record) => record.outcome === "fail").length;
  if (failed > 0) return { code: 1, hint: `有 ${failed} 步失败，按失败清单逐条处理后重跑` };
  const skipped = context.records.filter((record) => record.outcome === "skip").length;
  if (skipped > 0) {
    const hint =
      resolution.crossTenant.length > 0
        ? `缺前置：${resolution.crossTenant.map((item) => item.variables.join(" / ")).join("；")}`
        : "有步骤被跳过（对照数据缺失或票据未取得），结论不完整";
    return { code: 2, hint };
  }
  return { code: 0, hint: "三条判据全部通过" };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const resolution = resolveConfig(process.env);
  if (resolution.fatal.length > 0) {
    printMissingPrerequisites(resolution);
    process.exit(2);
  }

  const controller = new AbortController();
  const context: E2eContext = {
    config: resolution.config,
    http: {
      baseUrl: resolution.config.baseUrl,
      timeoutMs: resolution.config.timeoutMs,
      signal: controller.signal,
      activeOrgId: resolution.config.activeOrgId,
    },
    records: [],
    startedAt: new Date().toISOString(),
    cookie: null,
    signal: controller.signal,
    interrupted: false,
  };
  installSigint(context, controller);

  const state: RunState = {
    cookie: null,
    created: null,
    subjectLabel: "<未确定>",
    runId: Math.random().toString(16).slice(2, 8),
    facts: [],
  };

  try {
    await runPipeline(context, state);
  } catch (error) {
    // 未捕获异常也要有账目与建议：否则用户只看到堆栈，不知道哪一步断了。
    recordInfo(context, {
      id: "X1",
      group: GROUP_PREP,
      title: "未捕获异常",
      outcome: "fail",
      actual: `脚本内部异常：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      suggestion: "这是脚本缺陷：带上 --json 输出与触发步骤反馈",
    });
  }

  const cleanupNote = await cleanup(context, state);
  const { code, hint } = computeExitCode(context, resolution);

  await report(context, args, {
    notes: resolution.notes,
    subject: state.subjectLabel,
    facts: state.facts,
    cleanup: cleanupNote,
    exitCode: code,
    exitHint: hint,
  });
  process.exit(code);
}

await main();
