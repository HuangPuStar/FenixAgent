/**
 * Git 绑定的共用接入：作用域客户端的取得与绑定失败的统一映射。
 *
 * 从 `ticket-service.ts` 提取（backend contract §11.3）：T03 的 4 条写路径与既有读路径要的是**同一份**
 * 绑定错误映射，复制 4 份必然漂移，而漂移的后果是把「绑定被暂停 / 授权已被收回」显示成「工单不存在」。
 *
 * 两个不可改的口径：
 * - {@link TICKET_CONSUMER_ID} 必须与开通路径写入 `git_repository_bindings.allowed_consumers` 的键**同值**
 *   （`ticket-project-service.ts` 的 `TICKET_CONSUMER_GRANTS`）。换一个 ID 不会报错，只会让每个
 *   `createScopedClient` 在运行期变成授权失败。
 * - 绑定不可用是**装配/数据故障**（503，本端的问题）：上游在客户端握手阶段的 `FORBIDDEN` / `NOT_FOUND`
 *   说的不是「调用方没权限」也不是「工单不存在」，因此只能映射成 `GIT_UNAVAILABLE`；只有 `RATE_LIMITED`
 *   带独立错误码（前端提示「稍后重试」而不是「找运维」）。
 */

import type { GitScopedClient, GitService } from "@fenix/git/server";
import { GitUnavailableError } from "../errors";
import { classifyGitFailure } from "./git-failure";

/** 工单模块在 Git 绑定里的消费者 ID（与开通路径写入 `allowedConsumers` 的键一致，不得改名）。 */
export const TICKET_CONSUMER_ID = "tickets";

/** 绑定范围：三个字段都必须来自已授权的项目行，不得取自请求体。 */
export interface TicketBindingScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
}

/** 绑定不可用一律是装配/数据故障（§8.3 步骤 5），报 503 而不是伪装成「工单不存在」。 */
export function toTicketBindingError(error: unknown): Error {
  const failure = classifyGitFailure(error);
  if (failure === undefined) return error instanceof Error ? error : new Error(String(error));
  if (failure.kind === "definite" && failure.code === "RATE_LIMITED") {
    return new GitUnavailableError("托管平台限流，请稍后重试", "GIT_RATE_LIMITED");
  }
  return new GitUnavailableError("仓库绑定不可用：绑定已暂停或应用授权已被收回");
}

/** 取得工单模块在指定绑定上的作用域客户端；握手失败经 {@link toTicketBindingError} 收敛。 */
export async function connectTicketGitClient(git: GitService, scope: TicketBindingScope): Promise<GitScopedClient> {
  try {
    return await git.createScopedClient({
      consumerId: TICKET_CONSUMER_ID,
      organizationId: scope.organizationId,
      bindingId: scope.bindingId,
    });
  } catch (error) {
    throw toTicketBindingError(error);
  }
}
