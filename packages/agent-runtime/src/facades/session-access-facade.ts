/**
 * 控制面会话访问门面：`/web/sessions/:id/*` 的「会话 → 持久实例 → 环境 → 组织」归属链
 * （§3.2：route 不自行编排，需要组合多个动作时下沉到 Facade）。
 *
 * 为什么整条链都在这里：控制面的资源标识是持久 instanceUid，谁可以往该会话发事件由三步共同决定——
 * 会话在事件总线中活跃、实例属于请求方、实例绑定的环境在本组织内。三步原先写在路由的 `checkOwnership`
 * 中，路由因此既做协议接入又做归属编排；现在路由只保留「认证上下文是否完整」与「拒绝结论 → 响应」映射。
 *
 * 不接收宿主 `authContext` 整对象：门面只收组织与用户两个标识（与 `types/auth.ts` 的最小投影一致），
 * 归属规则按标识计算，调用方无从把宿主的 role / memberships 带进来。
 */

import { agentInstanceService } from "../server/services/agent-instance-service";
import { getSession, resolveExistingSessionId } from "../services/session";
import { environmentAccessFacade } from "./environment-access-facade";

/**
 * 拒绝结论：每个取值对应控制面一组既有的对外响应（状态码 + 错误码 + 文案），由路由映射，门面不产 HTTP。
 *
 * `session_not_owned` 合并了「实例不属于当前用户」与「实例绑定的环境已不存在」两种成因：两者在迁移前
 * 就返回逐字相同的 403，客户端无法区分，合并后也不产生新的可探测差异。
 */
export type SessionAccessDenial =
  | "session_not_found"
  | "session_not_owned"
  | "environment_foreign_organization"
  | "session_not_active";

/** 归属解析结论：通过时只向调用方暴露已解析的会话标识，不通过时给出拒绝成因。 */
export type SessionAccessResolution =
  | { readonly granted: true; readonly sessionId: string }
  | { readonly granted: false; readonly denial: SessionAccessDenial };

/** 控制面会话访问门面的契约面：路由只依赖本接口。 */
export interface SessionAccessFacadeApi {
  /**
   * 解析请求方对某会话的访问权；`sessionId` 为路径上的原始标识（持久 instanceUid）。
   *
   * 组织与用户必须由调用方从认证上下文提取后显式传入，且都不可为空——控制面在到达本方法前已确认请求
   * 携带完整认证上下文。
   */
  resolveAccess(sessionId: string, organizationId: string, userId: string): Promise<SessionAccessResolution>;
}

class SessionAccessFacade implements SessionAccessFacadeApi {
  async resolveAccess(sessionId: string, organizationId: string, userId: string): Promise<SessionAccessResolution> {
    const resolvedSessionId = await resolveExistingSessionId(sessionId);
    if (!resolvedSessionId) return { granted: false, denial: "session_not_found" };

    const environmentId = await this.#findOwnedEnvironmentId(resolvedSessionId, userId);
    if (!environmentId) return { granted: false, denial: "session_not_owned" };

    const environment = await environmentAccessFacade.resolveSessionEnvironment(environmentId, organizationId);
    if (!environment.reachable) {
      return {
        granted: false,
        denial: environment.reason === "other_organization" ? "environment_foreign_organization" : "session_not_owned",
      };
    }

    const activeSession = await getSession(resolvedSessionId);
    if (!activeSession) return { granted: false, denial: "session_not_active" };

    return { granted: true, sessionId: resolvedSessionId };
  }

  /**
   * 取该用户拥有的持久实例所绑定的环境标识；不可得即返回 `undefined`。
   *
   * 查询失败与「查不到」同样返回 `undefined`（fail-closed）：迁移前路由对 `getOwnedInstance` 的任何异常
   * 都按归属不匹配拒绝，把「归属结论不可得」降级成放行会是一次静默放宽。
   */
  async #findOwnedEnvironmentId(instanceUid: string, userId: string): Promise<string | undefined> {
    try {
      const instance = await agentInstanceService.getOwnedInstance(instanceUid, userId);
      return instance.environmentId;
    } catch {
      return;
    }
  }
}

/** 控制面会话访问门面单例：进程内只有一个实现。 */
export const sessionAccessFacade: SessionAccessFacadeApi = new SessionAccessFacade();
