/**
 * 资源授权的稳定错误契约。
 *
 * `AccessControlModule` 的实现位于 platform 层，不能抛宿主或资源包的错误类；被拒绝的主体必须能与
 * 「存储故障」「资源不存在」区分开，否则资源 Facade 只能把所有失败都映射成同一个 HTTP 状态。这里
 * 用携带稳定错误码与 HTTP 状态的错误类型表达「拒绝」，与身份侧的 `IdentityAuthenticationError`
 * 同形：跨包抛出、由接触协议的边界（Facade / route）映射成本层的错误。
 */

/**
 * 授权拒绝：主体对资源不具备所请求的动作（或创建期不具备 `create`）。
 *
 * 只有这一种失败是"拒绝"：`AccessControlModule` 实现不得用它包装存储或配置故障——那会让基础设施
 * 故障伪装成权限问题，也会让调用方（Facade 映射 403）掩盖真实原因。
 */
export class ResourceAccessDeniedError extends Error {
  readonly code = "FORBIDDEN";
  readonly statusCode = 403;

  constructor(message = "当前主体无权执行资源动作") {
    super(message);
    this.name = "ResourceAccessDeniedError";
  }
}
