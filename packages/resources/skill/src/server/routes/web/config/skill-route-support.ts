import type { ActorContext, IdentityDirectory } from "@fenix/platform-sdk";
import { WebErrSchema } from "@fenix/platform-sdk";
import { AppError } from "@server/errors";
import * as z from "zod/v4";
import type { SkillDetailView, SkillListItem } from "../../../facades/skill-facade";

/**
 * `/web/config/skills` 的协议层公共设施：错误映射、主体提取与视图映射。
 *
 * 单独成文件是因为它同时服务 skill 配置路由与技能上传解析，放在路由文件里会让该文件越过单文件行数
 * 上限；内容上它与 mcp 的同名路由保持同一套 `/web` 约定（错误码 → 声明过的状态码、`scope + access`
 * 视图、`organizationName` 作为可选展示字段）。
 */

export type WebErrorBody = z.infer<typeof WebErrSchema>;
/**
 * handler 的返回形状。
 *
 * 错误分支允许携带 `data`：技能上传冲突需要把 `conflicts` / `allowedStrategies` 传给前端，让用户选择
 * 忽略或覆盖（前端 `request.ts` 会把错误体里的 `data` 保留在 error 上）。其余错误不带附加字段。
 */
export type WebHandlerResult =
  | { success: true; data: Record<string, unknown> | null }
  | (WebErrorBody & { data?: unknown });

/** 错误码到 `/web` 声明过的 HTTP 状态码的映射；未列出的错误一律 400，避免返回未声明状态码。 */
function mapConfigErrorStatus(code: string | undefined): number {
  switch (code) {
    case "VALIDATION_ERROR":
      return 400;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "ALREADY_EXISTS":
      return 409;
    default:
      return 400;
  }
}

export function buildWebErrorBody(code: string, message: string): WebErrorBody {
  return { success: false, error: { code, message } };
}

/**
 * 上传冲突的错误体：除错误码外还要带上冲突清单与可用策略，路由据此返回 409。
 *
 * 冲突不是"请求非法"而是"需要用户决策"，因此不复用 400 的通用错误体。
 */
export function buildSkillConflictBody(conflicts: readonly { name: string; path: string }[]): WebHandlerResult {
  return {
    success: false,
    error: { code: "SKILL_CONFLICT", message: "检测到同名技能冲突" },
    data: { conflicts, allowedStrategies: ["ignore", "overwrite"] },
  };
}

/**
 * 上传冲突的 409 响应体 schema。
 *
 * `data` 必须在这里显式声明：Elysia 按响应 schema 清理返回值时，zod 对象会把未声明的键剥掉，
 * 冲突清单与可用策略就传不到前端——而前端的覆盖/忽略弹窗正是从错误体的 `data` 读取它们。
 */
export const SkillUploadConflictSchema = WebErrSchema.extend({
  data: z.object({
    conflicts: z.array(z.object({ name: z.string(), enabled: z.boolean(), path: z.string() })),
    allowedStrategies: z.array(z.enum(["ignore", "overwrite"])),
  }),
});

/**
 * 判断 handler 结果是否携带成功数据。
 *
 * 失败分支已经被 `runWebHandler` 映射为 Elysia 的响应标记（`status()` 的返回值），它不是错误体本身，
 * 调用方只能把它原样返回，不能再解构其中的字段。
 */
export function isWebSuccess(result: unknown): result is { success: true; data: Record<string, unknown> | null } {
  return typeof result === "object" && result !== null && (result as { success?: unknown }).success === true;
}

/**
 * 执行 handler：取主体 → 执行 → 把宿主错误类映射为 `/web` 错误体。未知错误保持上抛（500）。
 *
 * `statusOverrides` 让个别路由把某个错误码映射到"需要用户决策"的状态（上传冲突是 409 而不是 400）。
 * 映射必须在这里完成：返回值已经是响应标记，调用方拿不到错误码。
 */
export async function runWebHandler(
  // biome-ignore lint/suspicious/noExplicitAny: Elysia status 函数在自定义 response schema 下类型不稳定
  status: any,
  // biome-ignore lint/suspicious/noExplicitAny: Elysia store 类型未完全可表达
  store: any,
  handler: (actor: ActorContext) => Promise<WebHandlerResult>,
  statusOverrides: Readonly<Record<string, number>> = {},
): Promise<WebHandlerResult> {
  const actor = store.actor as ActorContext | null;
  if (!actor) {
    // 已认证但没有组织上下文（例如未绑定组织的 API Key）不能操作组织资源。
    return status(401, buildWebErrorBody("UNAUTHORIZED", "请求缺少组织上下文"));
  }
  try {
    const result = await handler(actor);
    if (result.success) return result;
    return status(statusOverrides[result.error.code] ?? mapConfigErrorStatus(result.error.code), result);
  } catch (error_) {
    if (error_ instanceof AppError) {
      return status(mapConfigErrorStatus(error_.code), buildWebErrorBody(error_.code, error_.message));
    }
    throw error_;
  }
}

/** 批量解析归属组织名称；名录缺失时字段整体省略，不补空串。 */
export async function resolveOrganizationNames(
  identity: IdentityDirectory,
  organizationIds: readonly (string | undefined)[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(organizationIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return new Map();
  return identity.listOrganizationNames(ids);
}

/**
 * 列表项视图。
 *
 * `enabled` 是历史字段：Skill 没有启停状态，协议保持常量 `true` 以免前端已有渲染分支失效；
 * 授权信息按决策 D2 改为 `scope + access`，`organizationName` 仅在名录可用时出现。
 */
export function toWebSkillItem(skill: SkillListItem, organizationName: string | undefined) {
  return {
    id: skill.id,
    name: skill.name,
    enabled: true,
    description: skill.description,
    path: skill.path,
    scope: skill.scope,
    access: skill.access,
    ...(organizationName === undefined ? {} : { organizationName }),
  };
}

/** 详情视图：列表项 + SKILL.md 正文与元数据。 */
export function toWebSkillDetail(skill: SkillDetailView, organizationName: string | undefined) {
  return {
    ...toWebSkillItem(skill, organizationName),
    content: skill.content,
    metadata: skill.metadata,
  };
}

/** 保存结果：创建/更新/改公开受众后回给前端的稳定片段（名称 + 归属范围 + 有效动作）。 */
export function toWebSkillSaveResult(skill: SkillListItem, organizationName: string | undefined) {
  return {
    name: skill.name,
    scope: skill.scope,
    access: skill.access,
    ...(organizationName === undefined ? {} : { organizationName }),
  };
}
