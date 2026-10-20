/**
 * 授权拒绝的共用收窄：平台的 `ResourceAccessDeniedError` → 对外 403，其余错误原样上抛。
 *
 * 为什么必须是共用实现（§11.3）：T02 的工单 Facade 与 T03 的评论/标签 Facade 都要做同一件事，而这段
 * 收窄有两处容易写错的边界——**只**认授权拒绝（存储故障、装配错误不得伪装成权限问题，否则排障会走错方向），
 * 以及放弃原始错误的信息（403 的文案只说「无权」）。三份副本必然在其中一处漂移。
 *
 * 收窄的是**执行动作**而不是错误对象：`authorizeAction`（单资源）与 `resolveInitialScope`（创建期归属）
 * 在基类里都返回 Promise，调用方按自己的文案传入，本函数不猜动作语义。
 *
 * T03 追加 {@link requireProjectAction} / {@link isProjectAdmin} 的理由：评论与标签的权限判定是
 * 「先问管理员身份、再按对象归属放行」，需要在同一处拿到 bool 与「拒绝即 403」两种出口；两者必须是同一次
 * `accessControl.authorize` 的两个出口（见各自注释）。
 */

import {
  type AccessControlModule,
  type ActorContext,
  ForbiddenError,
  ResourceAccessDeniedError,
  type ResourceAction,
  type ResourceDefinition,
} from "@fenix/platform-sdk";

/**
 * 执行一段需要授权的动作；授权拒绝转成 403，其余错误保持原样（含原始错误对象，交由上层错误处理器判定）。
 *
 * `message` 是给人看的文案，调用点各自给（例如「无权执行该项目动作」/「无权开通工单项目」）；它必须简短、
 * 不含资源内容与凭据——错误消息会被写进响应体与日志。
 */
export async function runTicketAuthorized<TResult>(run: () => Promise<TResult>, message: string): Promise<TResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ResourceAccessDeniedError) throw new ForbiddenError(message);
    throw error;
  }
}

/**
 * 单资源动作校验（合同 §2.3 逐字）：拒绝 → 403，其余错误原样上抛。
 *
 * 与 {@link runTicketAuthorized} 的差别是它直接吃 `AccessControlModule`，不要求调用方是
 * `AuthorizedResourceFacade` 的子类——评论/标签 Facade 需要在「判定管理员身份」与「要求管理员动作」两个
 * 语境里复用同一次调用，而基类的 `authorizeAction` 是 protected，外部拿不到。
 */
export async function requireProjectAction(input: {
  readonly accessControl: AccessControlModule;
  readonly resource: ResourceDefinition;
  readonly actor: ActorContext;
  readonly action: ResourceAction;
  readonly projectId: string;
  readonly message: string;
}): Promise<void> {
  try {
    await input.accessControl.authorize({
      actor: input.actor,
      action: input.action,
      resource: input.resource,
      resourceId: input.projectId,
    });
  } catch (error) {
    if (error instanceof ResourceAccessDeniedError) throw new ForbiddenError(input.message);
    throw error;
  }
}

/**
 * 布尔形态的管理员判定（「管理员可为任何事」的分支用）：拒绝返回 false，其它错误仍原样上抛。
 *
 * 与 {@link requireProjectAction} **Must 复用同一实现**：本函数捕获的是上一步亲手构造的 `ForbiddenError`
 * （唯一的授权拒绝出口），因此「存储故障被吞成 false」这类漂移在结构上不可能发生——若各自写一份
 * try/catch，另一份迟早会把非授权错误也判成「不是管理员」，让管理员静默失去权限。
 */
export async function isProjectAdmin(
  input: Omit<Parameters<typeof requireProjectAction>[0], "message">,
): Promise<boolean> {
  try {
    await requireProjectAction({ ...input, message: "当前主体无权执行该项目动作" });
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
}
