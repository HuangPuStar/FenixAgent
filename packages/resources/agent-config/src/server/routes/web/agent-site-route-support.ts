import type { WebErr } from "@fenix/platform-sdk";
import {
  type AgentSiteAppView,
  SiteAppActionError,
  type SiteAppFailureReason,
} from "../../facades/agent-site-app-facade";
import type { AgentSiteApp } from "../../schemas/agent-site.schema";

/**
 * `/web/agent-sites` 的协议层公共设施：DTO 映射与错误映射。
 *
 * 这里**不做任何授权判断**：可见性、写权限与创建规则都由 `getAgentConfigModule().siteFacade` 产出，
 * 本文件只把 Facade 的结果映射成 `/web` 契约的形状（响应对象、状态码、错误码与文案）。
 *
 * 入参类型只取自 Facade 的视图契约（`AgentSiteAppView`），不向上游要持久化模型：协议层与仓储层之间
 * 隔着 Facade 与 Domain Service（§3.2），引用仓储行类型会让"改列名就编译失败"扩散到协议层。
 */

/** 将 Facade 视图转为 API 响应（秒级时间戳，不包含 platformToken）。 */
export function toResponse(row: AgentSiteAppView): AgentSiteApp {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    remoteAppId: row.remoteAppId,
    name: row.name,
    description: row.description ?? null,
    visibility: (row.visibility as AgentSiteApp["visibility"] | undefined) ?? "private",
    appType: (row.appType as AgentSiteApp["appType"] | undefined) ?? "pocketbase",
    entryFile: row.entryFile ?? null,
    activeSlot: (row.activeSlot as AgentSiteApp["activeSlot"] | undefined) ?? null,
    deployedAt: row.deployedAt ? Math.floor(row.deployedAt.getTime() / 1000) : null,
    createdByAgentConfigId: row.createdByAgentConfigId ?? null,
    createdAt: row.createdAt ? Math.floor(new Date(row.createdAt).getTime() / 1000) : 0,
    updatedAt: row.updatedAt ? Math.floor(new Date(row.updatedAt).getTime() / 1000) : 0,
  };
}

/** 带创建者展示名的视图响应：只有存在创建者配置的行才带该字段（创建者已删除时为 null）。 */
export function toViewResponse(view: AgentSiteAppView): AgentSiteApp {
  const response = toResponse(view);
  if (view.createdByAgentConfigId) {
    response.createdByAgentConfigName = view.createdByAgentConfigName;
  }
  return response;
}

/**
 * 构造统一的 /web 错误体，交给 Elysia `status()` 标注状态码。
 */
function buildError(code: string, message: string): WebErr {
  return {
    success: false,
    error: {
      code,
      message,
    },
  };
}

/** 端点各自的 403 文案；写权限判定只有一份，文案按动作区分（既有 `/web` 契约）。 */
export const FORBIDDEN_MESSAGE = {
  update: "无权限修改此 app",
  delete: "无权限删除此 app",
  rotateToken: "无权限操作此 app",
  uploadFile: "无权限上传文件",
  deploy: "无权限部署此 app",
} as const;

/** 失败语义 → `/web` 状态码；与既有响应 schema 声明的状态码一一对应。 */
function statusOfSiteFailure(reason: SiteAppFailureReason): number {
  switch (reason) {
    case "no_organization":
      return 401;
    case "site_not_found":
    case "agent_not_found":
      return 404;
    case "forbidden":
      return 403;
    case "not_custom":
    case "pocketbase_unsupported":
      return 400;
  }
}

/** 失败语义 → `/web` 错误码；沿用站点路由既有的小写错误码。 */
function codeOfSiteFailure(reason: SiteAppFailureReason): string {
  switch (reason) {
    case "no_organization":
      return "unauthorized";
    case "site_not_found":
      return "not_found";
    case "agent_not_found":
      return "not_found";
    case "forbidden":
      return "forbidden";
    case "not_custom":
    case "pocketbase_unsupported":
      return "bad_request";
  }
}

/** 失败语义 → 对用户可见文案。
 *
 * 与状态码分开的理由：同一条语义在不同端点上说法不同（`forbidden` 是"无权限修改此 app"还是"无权限
 * 部署此 app"），由调用方经 `overrides` 传入本端点的说法。
 */
function messageOfSiteFailure(
  error: SiteAppActionError,
  overrides: Partial<Record<SiteAppFailureReason, string>> = {},
): string {
  const override = overrides[error.reason];
  if (override !== undefined) return override;
  switch (error.reason) {
    case "no_organization":
      return "请求缺少组织上下文";
    case "site_not_found":
      return "App 不存在";
    case "agent_not_found":
      return "Agent 配置不存在";
    case "forbidden":
      return "无权限操作此 app";
    case "not_custom":
      return `App ${error.context.remoteAppId} 不是 custom 类型，无法部署（当前: ${error.context.appType}）`;
    case "pocketbase_unsupported":
      return `Custom 类型 app ${error.context.remoteAppId} 不支持 PocketBase API，请走业务前端 /web/site/deploy/${error.context.remoteAppId}/* 或 L1 deploy 接口`;
  }
}

/** Elysia `status` 在本包用到的形状：写入状态码并返回同一个错误体。 */
type StatusWriter = (code: number, body: WebErr) => WebErr;

/**
 * 失败语义 → 状态码与错误体。
 *
 * 未识别的错误原样上抛（500）：存储故障、上游故障与装配错误不得被伪装成协议错误。
 */
export function toSiteFailure(
  error: unknown,
  messages: Partial<Record<SiteAppFailureReason, string>> = {},
): { readonly status: number; readonly body: WebErr } {
  if (!(error instanceof SiteAppActionError)) throw error;
  const reason = error.reason;
  return {
    status: statusOfSiteFailure(reason),
    body: buildError(codeOfSiteFailure(reason), messageOfSiteFailure(error, messages)),
  };
}

/**
 * 执行站点动作并把 {@link SiteAppActionError} 映射为 `/web` 错误响应。
 *
 * 成功值是 `T`（Elysia 按状态码 200 与声明的响应 schema 写出），失败值是 `status()` 标记的响应。
 */
export async function runSiteAction<T>(
  status: StatusWriter,
  run: () => Promise<T>,
  messages: Partial<Record<SiteAppFailureReason, string>> = {},
): Promise<T | WebErr> {
  try {
    return await run();
  } catch (error) {
    const failure = toSiteFailure(error, messages);
    return status(failure.status, failure.body);
  }
}
