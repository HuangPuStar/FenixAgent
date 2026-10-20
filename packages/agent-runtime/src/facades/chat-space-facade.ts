/**
 * 会话分组门面：`/web/chat-spaces/**` 的「分组 → 持久实例 → 环境 → 组织」授权链与领域调用编排
 * （§3.2：route 不自行编排归属判断，需要组合多个动作时下沉到 Facade）。
 *
 * 为什么整条链都在这里：分组的资源标识是持久 `instanceUid`，请求方能否读写某个分组由两步共同决定——
 * 实例属于请求方（用户维度），且实例绑定的环境落在请求方的组织内（组织维度）。这两步与
 * `facades/session-access-facade` 用的是同一条链，因此路由不再各写一遍 `checkOwnership`，
 * 只保留「认证上下文是否完整」与「门面结论 → 响应」的映射。
 *
 * **两个入口，差别只在定位符**：
 * - 列表、创建与移出以实例定位，走 {@link ChatSpaceInstanceAccessInput}；
 * - 重命名与移入以分组定位，走 {@link ChatSpaceSpaceAccessInput}。这两条同样携带 `instanceUid`，
 *   它是权威作用域：调用方必须对该实例持有归属，分组 id 只在这个作用域内解析。分组行与 `instanceUid` 不是
 *   同一个实例即 404——同一用户跨实例去碰一个分组不因「两边都属于他」而放行。
 *
 * 「移出」刻意不走分组定位：它表达的是「这个会话不再属于任何分组」，按分组定位会逼调用方先反查服务端归属，
 * 而那份反查在本地快照滞后于在途写入时会指到旧分组（详见 {@link ChatSpaceServiceApi.removeSession}）。
 *
 * 组织维度的判定口径与控制面一致：`environmentAccessFacade.resolveSessionEnvironment` 容忍「未挂组织」
 * 的存量环境（这类环境的用户维度已由实例归属校验覆盖），把跨组织环境判成 403。不引入 actor 类型：本包
 * 不认识宿主的 `role` / `memberships`，门面只接收组织与用户两个原始标识。
 */

import { AppError } from "@fenix/platform-sdk";
import type { ChatSpaceRecord, ChatSpaceScope } from "../server/repositories/chat-space";
import { agentInstanceService } from "../server/services/agent-instance-service";
import {
  chatSpaceForbiddenError,
  chatSpaceNotFoundError,
  instanceNotFoundError,
} from "../server/services/chat-space-errors";
import { type ChatSpaceServiceApi, chatSpaceService } from "../server/services/chat-space-service";
import { environmentAccessFacade } from "./environment-access-facade";

/** 认证上下文里的两个原始标识：都不可为空，路由在到达本层前已确认。 */
export interface ChatSpaceAccessContext {
  readonly organizationId: string;
  readonly userId: string;
}

/** 以实例为定位符的入参（GET / POST）。 */
export type ChatSpaceInstanceAccessInput = ChatSpaceAccessContext & { readonly instanceUid: string };

/** 以分组为定位符的入参（PATCH / PUT / DELETE）：`instanceUid` 是权威作用域，分组必须落在它之内。 */
export type ChatSpaceSpaceAccessInput = ChatSpaceInstanceAccessInput & { readonly spaceId: string };

/** 会话分组门面的契约面：路由只依赖本接口，不依赖实现类。 */
export interface ChatSpaceFacadeApi {
  listSpaces(input: ChatSpaceInstanceAccessInput): Promise<ChatSpaceRecord[]>;
  createSpace(input: ChatSpaceInstanceAccessInput & { readonly name: string }): Promise<ChatSpaceRecord>;
  renameSpace(input: ChatSpaceSpaceAccessInput & { readonly name: string }): Promise<ChatSpaceRecord>;
  assignSession(input: ChatSpaceSpaceAccessInput & { readonly sessionId: string }): Promise<ChatSpaceRecord>;
  /** 取消归属：会话从该实例的所有分组摘除；本就不在任何分组时返回 `undefined`（幂等成功）。 */
  removeSession(
    input: ChatSpaceInstanceAccessInput & { readonly sessionId: string },
  ): Promise<ChatSpaceRecord | undefined>;
}

class ChatSpaceFacade implements ChatSpaceFacadeApi {
  constructor(private readonly service: ChatSpaceServiceApi) {}

  async listSpaces(input: ChatSpaceInstanceAccessInput): Promise<ChatSpaceRecord[]> {
    return this.service.listSpaces(await this.#scopeForInstance(input));
  }

  async createSpace(input: ChatSpaceInstanceAccessInput & { readonly name: string }): Promise<ChatSpaceRecord> {
    return this.service.createSpace({ ...(await this.#scopeForInstance(input)), name: input.name });
  }

  async renameSpace(input: ChatSpaceSpaceAccessInput & { readonly name: string }): Promise<ChatSpaceRecord> {
    return this.service.renameSpace({
      ...(await this.#scopeForSpace(input)),
      spaceId: input.spaceId,
      name: input.name,
    });
  }

  async assignSession(input: ChatSpaceSpaceAccessInput & { readonly sessionId: string }): Promise<ChatSpaceRecord> {
    return this.service.assignSession({
      ...(await this.#scopeForSpace(input)),
      spaceId: input.spaceId,
      sessionId: input.sessionId,
    });
  }

  async removeSession(
    input: ChatSpaceInstanceAccessInput & { readonly sessionId: string },
  ): Promise<ChatSpaceRecord | undefined> {
    // 实例授权即可，不再解析分组行：摘除由 scope 决定范围（见接口注释），调用方不需要知道会话当前属于谁。
    return this.service.removeSession({ ...(await this.#scopeForInstance(input)), sessionId: input.sessionId });
  }

  /** 以实例为定位符的授权：校验实例归属（用户）与其环境的组织归属，通过后返回已授权 scope。 */
  async #scopeForInstance(input: ChatSpaceInstanceAccessInput): Promise<ChatSpaceScope> {
    const instance = await this.#ownedInstance(input.instanceUid, input);
    return { instanceUid: instance.id, userId: input.userId };
  }

  /**
   * 以分组为定位符的授权：先按 `instanceUid` 完成实例授权（权威作用域），再确认分组行确实属于该实例与当前
   * 用户。分组是别人的、已不存在、或挂在另一个实例下，都落同一个 404——区分它们会泄露「该分组存在」，
   * 跨实例不一致更不该因为「两边都属于同一用户」而放行。
   */
  async #scopeForSpace(input: ChatSpaceSpaceAccessInput): Promise<ChatSpaceScope> {
    const scope = await this.#scopeForInstance(input);
    const space = await this.service.findByIdForUser({ spaceId: input.spaceId, userId: input.userId });
    if (!space || space.instanceUid !== scope.instanceUid) throw chatSpaceNotFoundError();
    return scope;
  }

  /**
   * 实例归属（用户维度）与其环境组织归属（组织维度）的校验，通过后返回实例。
   */
  async #ownedInstance(instanceUid: string, input: ChatSpaceAccessContext) {
    const instance = await this.#getOwnedInstanceOrThrow(instanceUid, input.userId);
    // 组织维度：实例绑定的环境必须落在当前组织内（跨组织 403，环境已消失 404）。
    const environment = await environmentAccessFacade.resolveSessionEnvironment(
      instance.environmentId,
      input.organizationId,
    );
    if (!environment.reachable) {
      if (environment.reason === "other_organization") throw chatSpaceForbiddenError();
      throw instanceNotFoundError();
    }
    return instance;
  }

  /**
   * 实例归属的等价窄口。
   *
   * `agentInstanceService.getOwnedInstance` 对「格式非法」「不存在」「属于别人」都抛同一个 404，这里如实
   * 转成统一文案，不区分成因——区分会给出跨用户的实例存在性。**非 `AppError` 异常原样上抛**：存储或装配
   * 故障不是归属问题，伪装成 404 会让故障不可诊断（并不放行，因此仍是 fail-closed）。
   *
   * try 只包这一处：本方法外抛的 AppError（403/404 文案）若是落在 try 里，会被下面的转换改写成 404。
   */
  async #getOwnedInstanceOrThrow(instanceUid: string, userId: string) {
    try {
      return await agentInstanceService.getOwnedInstance(instanceUid, userId);
    } catch (error) {
      if (error instanceof AppError) throw instanceNotFoundError();
      throw error;
    }
  }
}

/** 会话分组门面单例：进程内只有一个实现。 */
export const chatSpaceFacade: ChatSpaceFacadeApi = new ChatSpaceFacade(chatSpaceService);
