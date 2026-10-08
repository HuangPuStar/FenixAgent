/**
 * 画布端到端联调（1J）的控制台链路：会话、平台账号投影、租户 App 绑定、临时 workflow 与一次性 code。
 *
 * 这些调用走 `/web/workflow-v2/*`（`{success,data}` 口径，会话 cookie 鉴权），与画布面的上游信封口径
 * 分属两套，判读函数也不同（`judgeConsoleSuccess` vs `judgeUpstreamSuccess`）。
 *
 * 为什么要在这里做「准备」而不要求调用方事先备好 ID：判据 B 需要**服务端注入的权威值**（空间 ID 与租户
 * App ID）来对照，判据 C 需要一个属于别的组织的真实 workflow——两者都只能从控制台面读出来。让持有凭据的
 * 部署方手工去捞这些 ID，等于把「一键跑」变成「先自己拼一遍链路」。
 *
 * 副作用边界（脚本可重复运行的前提）：
 * - `POST /org-app` 只在组织尚未绑定时调用（幂等；上游侧会因此多一个 App，上游没有删除 App 的接口，
 *   这是**不可回收**的副作用，所以调用前会打印说明，并可用 WORKFLOW_V2_E2E_AUTO_BIND=0 关闭）。
 * - `POST /workflows` 创建的临时 workflow 由入口在结束时删除（`DELETE /workflows/:id?force=true`）。
 * - 其余全是读接口。
 */

import {
  type E2eContext,
  type E2eResponse,
  GROUP_CLEANUP,
  GROUP_PREP,
  recordInfo,
  recordSkip,
  runStep,
} from "./e2e-core";
import { judgeConsoleSuccess, toEvidence } from "./e2e-logic";

/** 自动绑定时创建的租户 App 名（控制台「初始化工作流空间」的等价动作；同名不敏感，上游侧以 ID 为准）。 */
const AUTO_BOUND_APP_NAME = "fenix-workflow-space";
/** 登录路径的证据只列 cookie 名，绝不列值。 */
function cookieNames(setCookies: readonly string[]): string[] {
  return setCookies
    .map((header) => header.split(";")[0]?.split("=")[0]?.trim() ?? "")
    .filter((name) => name.length > 0);
}

/** 把 `Set-Cookie` 折成一条 `Cookie` 请求头：只取 `name=value` 段，属性（Path/HttpOnly/…）全部丢弃。 */
function collectCookie(setCookies: readonly string[]): string {
  return setCookies
    .map((header) => header.split(";")[0]?.trim() ?? "")
    .filter((pair) => pair.includes("=") && !pair.startsWith("="))
    .join("; ");
}

/**
 * 用控制台账号登录换会话 cookie（`POST /api/auth/sign-in/email`，better-auth 协议面）。
 *
 * 登录请求刻意**不带 Cookie**：better-auth 的 origin 校验只在请求带 cookie 时才生效，本平台的
 * 可信来源（RCS_BASE_URL / BETTER_AUTH_URL）在部署间不一致，脚本去猜一个 Origin 只会带来假失败。
 * 响应体形状属 better-auth 内部实现，不作断言——会话是否真的可用，交给下一步的 `/platform-account` 验证。
 * 密码只作为请求体使用一次，不落盘、不进证据、不进日志。
 */
export async function login(
  context: E2eContext,
  input: { email: string; password: string; idPrefix: string; title: string },
): Promise<string | null> {
  const response = await runStep(context, {
    id: `${input.idPrefix}.login`,
    group: GROUP_PREP,
    title: input.title,
    request: {
      method: "POST",
      path: "/api/auth/sign-in/email",
      body: { email: input.email, password: input.password },
    },
    judge: (res) => {
      const expected = "HTTP 2xx + Set-Cookie: 会话 cookie";
      const actual =
        res.httpStatus === null
          ? `请求未完成（${res.error}）`
          : `HTTP ${res.httpStatus}，Set-Cookie ${res.setCookies.length} 条`;
      if (res.httpStatus !== null && res.httpStatus >= 400) {
        return {
          ok: false,
          expected,
          actual,
          suggestion:
            "登录被拒：核对 WORKFLOW_V2_E2E_EMAIL / PASSWORD（账号须已注册），或改用 WORKFLOW_V2_E2E_SESSION_COOKIE",
        };
      }
      if (collectCookie(res.setCookies).length === 0) {
        return {
          ok: false,
          expected,
          actual,
          suggestion: "登录未返回会话 cookie：确认账号密码正确（本平台不在响应体里回传会话）",
        };
      }
      return { ok: true, expected, actual, suggestion: null };
    },
    evidence: (res) => `Set-Cookie 名称：${cookieNames(res.setCookies).join(", ") || "<无>"}`,
  });
  const cookie = collectCookie(response.setCookies);
  return cookie.length > 0 ? cookie : null;
}

/** 取得可用的控制台会话：环境变量给了 cookie 就直接用，否则登录。 */
export async function ensureSession(context: E2eContext): Promise<string | null> {
  const preset = context.config.sessionCookie;
  if (preset) {
    recordInfo(context, {
      id: "P0.session",
      group: GROUP_PREP,
      title: "控制台会话（环境变量）",
      outcome: "pass",
      actual: "使用 WORKFLOW_V2_E2E_SESSION_COOKIE；是否仍然有效由下一步读取平台账号验证",
    });
    return preset;
  }
  const email = context.config.email;
  const password = context.config.password;
  if (!email || !password) return null;
  return login(context, { email, password, idPrefix: "P0", title: "控制台登录（组织 A 账号）" });
}

/** 读平台账号投影：`spaceId` 是判据 B 里 `space_id` 的权威值来源（台账无行时为 null）。 */
export async function readPlatformAccount(
  context: E2eContext,
  input: { cookie: string; id: string },
): Promise<E2eResponse> {
  return runStep(context, {
    id: input.id,
    group: GROUP_PREP,
    title: "读取平台账号 / 空间投影",
    request: { method: "GET", path: "/web/workflow-v2/platform-account", cookie: input.cookie },
    judge: (res) => judgeConsoleSuccess(res.httpStatus, res.json),
    evidence: (res) => toEvidence(res.json),
  });
}

/** 读租户 App 绑定：`appId` 是判据 B 里 `project_id` / `bot_id` 的权威值来源。 */
export async function readOrgApp(context: E2eContext, input: { cookie: string; id: string }): Promise<E2eResponse> {
  return runStep(context, {
    id: input.id,
    group: GROUP_PREP,
    title: "读取租户 App 绑定",
    request: { method: "GET", path: "/web/workflow-v2/org-app", cookie: input.cookie },
    judge: (res) => judgeConsoleSuccess(res.httpStatus, res.json),
    evidence: (res) => toEvidence(res.json),
  });
}

/** 建绑（幂等）：仅在未绑定且允许自动绑定时调用，返回值以重新读取的绑定为准。 */
export async function bindOrgApp(context: E2eContext, input: { cookie: string; id: string }): Promise<boolean> {
  if (!context.config.autoBind) {
    recordSkip(context, {
      id: input.id,
      group: GROUP_PREP,
      title: "自动绑定租户 App",
      reason: "已关闭 WORKFLOW_V2_E2E_AUTO_BIND，且该组织尚未绑定上游应用",
    });
    return false;
  }
  const response = await runStep(context, {
    id: input.id,
    group: GROUP_PREP,
    title: "绑定租户 App（幂等；上游侧建 App）",
    request: {
      method: "POST",
      path: "/web/workflow-v2/org-app",
      cookie: input.cookie,
      body: { name: AUTO_BOUND_APP_NAME },
    },
    judge: (res) => judgeConsoleSuccess(res.httpStatus, res.json),
    evidence: (res) => {
      const appId = (res.json as { data?: { appId?: unknown } } | undefined)?.data?.appId;
      return typeof appId === "string" ? `返回 appId=${appId}` : null;
    },
  });
  return response.httpStatus === 200;
}

export interface CreatedWorkflow {
  readonly localId: string;
  readonly upstreamWorkflowId: string;
  readonly name: string;
}

/** 在组织 A 下创建一个临时 workflow（上游 `POST /api/workflow_api/create`，服务端注入 space/project）。 */
export async function createWorkflow(
  context: E2eContext,
  input: { cookie: string; name: string; id: string },
): Promise<CreatedWorkflow | null> {
  const response = await runStep(context, {
    id: input.id,
    group: GROUP_PREP,
    title: "创建临时 workflow",
    request: {
      method: "POST",
      path: "/web/workflow-v2/workflows",
      cookie: input.cookie,
      body: { name: input.name, desc: "canvas e2e check（脚本创建，结束删除）" },
    },
    judge: (res) => judgeConsoleSuccess(res.httpStatus, res.json),
    evidence: (res) => toEvidence(res.json),
  });
  const data = (response.json as { data?: { id?: unknown; upstreamWorkflowId?: unknown } } | undefined)?.data;
  const localId = typeof data?.id === "string" ? data.id : null;
  const upstreamWorkflowId = typeof data?.upstreamWorkflowId === "string" ? data.upstreamWorkflowId : null;
  if (!localId || !upstreamWorkflowId) return null;
  return { localId, upstreamWorkflowId, name: input.name };
}

/** 列出当前会话所属组织的工作流（组织 B 取对照 workflow 用；也是「不创建垃圾数据」的首选来源）。 */
export async function listWorkflows(
  context: E2eContext,
  input: { cookie: string; idPrefix: string; title: string; group: string },
): Promise<{ upstreamWorkflowId: string; name: string }[]> {
  const response = await runStep(context, {
    id: input.idPrefix,
    group: input.group,
    title: input.title,
    request: {
      method: "GET",
      path: "/web/workflow-v2/workflows",
      cookie: input.cookie,
      query: { page: "1", size: "1" },
    },
    judge: (res) => judgeConsoleSuccess(res.httpStatus, res.json),
    evidence: (res) => toEvidence(res.json),
  });
  const items = (response.json as { data?: { items?: unknown } } | undefined)?.data?.items;
  if (!Array.isArray(items)) return [];
  const parsed: { upstreamWorkflowId: string; name: string }[] = [];
  for (const item of items) {
    const record = item as { upstreamWorkflowId?: unknown; name?: unknown };
    if (typeof record.upstreamWorkflowId === "string") {
      parsed.push({
        upstreamWorkflowId: record.upstreamWorkflowId,
        name: typeof record.name === "string" ? record.name : "<无名>",
      });
    }
  }
  return parsed;
}

/** 删除临时 workflow：本地软删 + 上游删除（`force=true` 跳过删除策略判定）。 */
export async function deleteWorkflow(context: E2eContext, cookie: string, localId: string): Promise<boolean> {
  const response = await runStep(context, {
    id: "Z1",
    group: GROUP_CLEANUP,
    title: "删除临时 workflow",
    request: { method: "DELETE", path: `/web/workflow-v2/workflows/${localId}`, cookie, query: { force: "true" } },
    judge: (res) => {
      const judged = judgeConsoleSuccess(res.httpStatus, res.json);
      const deleted = (res.json as { data?: { deleted?: unknown } } | undefined)?.data?.deleted;
      if (judged.ok && deleted !== true) {
        return {
          ok: false,
          expected: "HTTP 2xx + { success: true, data: { deleted: true } }",
          actual: judged.actual,
          suggestion: "本地未删成（可能是上游删除策略拒绝）：到控制台列表确认该临时 workflow 是否已消失",
        };
      }
      return judged;
    },
    evidence: (res) => toEvidence(res.json),
  });
  return response.httpStatus === 200;
}

/** 签发一次性 code（60s、单次消费，绑定 user + org + workflow）；id/group 由调用方给，三条判据各自记账。 */
export async function issueCode(
  context: E2eContext,
  input: { cookie: string; workflowId: string; id: string; group: string; title: string },
): Promise<string | null> {
  const response = await runStep(context, {
    id: input.id,
    group: input.group,
    title: input.title,
    request: {
      method: "POST",
      path: "/web/workflow-v2/iframe-code",
      cookie: input.cookie,
      body: { workflowId: input.workflowId },
    },
    judge: (res) => judgeConsoleSuccess(res.httpStatus, res.json),
    evidence: (res) => toEvidence(res.json),
  });
  const code = (response.json as { data?: { code?: unknown } } | undefined)?.data?.code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/**
 * 登录组织 B（判据 C 的对照方）并取其名下第一个 workflow。
 *
 * 用**已存在**的 workflow 而不是新建：判据 C 要证明的是「另一个组织的真实资源对本组织不可见」，新建一个
 * 只会在上游侧多留一份测试数据。组织 B 一个 workflow 都没有时如实返回 null（由入口记为缺前置）。
 */
export async function resolveForeignWorkflow(
  context: E2eContext,
): Promise<{ upstreamWorkflowId: string; name: string } | null> {
  const preset = context.config.foreignWorkflowId;
  if (preset) {
    recordInfo(context, {
      id: "C0",
      group: "C 跨租户 404",
      title: "对照 workflow（环境变量）",
      outcome: "pass",
      actual: `使用 WORKFLOW_V2_E2E_FOREIGN_WORKFLOW_ID=${preset}`,
    });
    return { upstreamWorkflowId: preset, name: "由环境变量给定" };
  }
  const email = context.config.foreignEmail;
  const password = context.config.foreignPassword;
  if (!email || !password) return null;
  const cookie = await login(context, { email, password, idPrefix: "C0", title: "控制台登录（组织 B 账号）" });
  if (cookie === null) return null;
  const items = await listWorkflows(context, {
    cookie,
    idPrefix: "C1",
    title: "列出组织 B 的 workflow",
    group: "C 跨租户 404",
  });
  const first = items[0];
  if (!first) {
    recordSkip(context, {
      id: "C1",
      group: "C 跨租户 404",
      title: "对照 workflow 取值",
      reason: `组织 B（${email}）名下没有已登记的 workflow：先在该组织控制台创建一个再重跑`,
    });
    return null;
  }
  return first;
}
