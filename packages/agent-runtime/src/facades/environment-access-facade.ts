/**
 * Environment 访问门面：本包路由读取 Environment、判定其归属的唯一入口
 * （§3.2 的 `route → Facade → repository`，route 不直接访问 repository、不自行拼装组织条件）。
 *
 * 为什么需要这一层：`routes/acp/index.ts` 与 `routes/web/control.ts` 原先各自直引 `environmentRepo`，
 * 并在路由里写 `env.organizationId !== authCtx.organizationId` 这类租户判断。同一条归属规则被写在两处
 * 路由上，任何一处调整都要靠人去核对另一处；收口到这里之后，路由只把认证上下文里的原始标识传进来，
 * 并按门面给出的结论映射协议响应。
 *
 * 三条方法的租户口径**有意不同**，是既有行为的显式化而不是可互相替代的变体：
 * - {@link EnvironmentAccessFacadeApi.listAcpEnvironments} 按归属键列表（无组织上下文时退化为个人范围）；
 * - {@link EnvironmentAccessFacadeApi.resolveOwnedEnvironment} 组织与用户都必须一致（YJS 会话端点升级前校验）；
 * - {@link EnvironmentAccessFacadeApi.resolveSessionEnvironment} 容忍「未挂组织」的环境（控制面回查，
 *   用户维度已由持久实例归属校验覆盖）。
 *
 * 不引入 actor 类型：本包不认识宿主的 `role` / `memberships`（`types/auth.ts` 的最小投影），门面只接收
 * 「组织 + 用户」两个原始标识，避免把宿主授权模型带进 runtime。
 */

import type { EnvironmentRecord } from "../server/repositories/environment";
import { environmentRepo } from "../server/repositories/environment";

/**
 * 控制面回查实例所绑定环境的结论。
 *
 * 不可达时分出 `missing`（环境不存在）与 `other_organization`（环境属于别的组织）：两者在控制面的对外
 * 响应文案不同，调用方据此映射。本类型是门面的公开契约，不是仓储错误的转发。
 */
export type SessionEnvironmentResolution =
  | { readonly reachable: true; readonly environment: EnvironmentRecord }
  | { readonly reachable: false; readonly reason: "missing" | "other_organization" };

/** 环境访问门面的契约面：路由只依赖本接口，不依赖实现类。 */
export interface EnvironmentAccessFacadeApi {
  /**
   * 本组织（无组织上下文时为本用户）名下的 ACP 环境列表。
   *
   * 归属键的退化规则（`organizationId` 为空即以 `userId` 归属）收在这里而不是留给路由：环境记录在未挂
   * 组织时本就以 `userId` 落库（仓储 `rowToRecord` 的同一约定），它属于本包的环境归属规则。
   */
  listAcpEnvironments(organizationId: string | null, userId: string): Promise<EnvironmentRecord[]>;

  /**
   * 严格归属读取：环境存在、组织完全一致且属于该用户，否则返回 `undefined`。
   *
   * `organizationId` 为 `null` 表示请求没有组织上下文（认证结果缺 `authContext`），一律不可达——与迁移前
   * 的 `!authCtx` 提前拒绝同义。返回 `undefined` 而非抛错：调用方是 WS 升级路径，拒绝形态（4003 关闭）
   * 属协议层，门面只回答「可达 / 不可达」。
   */
  resolveOwnedEnvironment(
    environmentId: string,
    organizationId: string | null,
    userId: string,
  ): Promise<EnvironmentRecord | undefined>;

  /**
   * 控制面回查：实例绑定的环境是否落在请求方的组织内。
   *
   * 容忍「未挂组织」的环境（`organizationId` 为空即跳过组织比较）：这类环境的用户维度已由持久实例的
   * 归属校验（`agentInstanceService.getOwnedInstance`，按 `ownerUserId` 查行）保证，把它们判成跨组织会让
   * 无组织归属的存量环境对任何请求方都不可用。
   */
  resolveSessionEnvironment(environmentId: string, organizationId: string): Promise<SessionEnvironmentResolution>;
}

class EnvironmentAccessFacade implements EnvironmentAccessFacadeApi {
  async listAcpEnvironments(organizationId: string | null, userId: string): Promise<EnvironmentRecord[]> {
    const environments = await environmentRepo.listByOrganizationId(organizationId ?? userId);
    return environments.filter((environment) => environment.workerType === "acp");
  }

  async resolveOwnedEnvironment(
    environmentId: string,
    organizationId: string | null,
    userId: string,
  ): Promise<EnvironmentRecord | undefined> {
    if (!organizationId) return;
    const environment = await environmentRepo.getById(environmentId);
    if (!environment || environment.organizationId !== organizationId || environment.userId !== userId) {
      return;
    }
    return environment;
  }

  async resolveSessionEnvironment(
    environmentId: string,
    organizationId: string,
  ): Promise<SessionEnvironmentResolution> {
    const environment = await environmentRepo.getById(environmentId);
    if (!environment) return { reachable: false, reason: "missing" };
    if (environment.organizationId && environment.organizationId !== organizationId) {
      return { reachable: false, reason: "other_organization" };
    }
    return { reachable: true, environment };
  }
}

/** 环境访问门面单例：进程内只有一个实现，替换点仍是仓储自身的测试替身层。 */
export const environmentAccessFacade: EnvironmentAccessFacadeApi = new EnvironmentAccessFacade();
