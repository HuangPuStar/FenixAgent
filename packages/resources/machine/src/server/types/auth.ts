/**
 * 本包路由与服务读取的「请求认证视图」。
 *
 * 为什么不直接用宿主的 `AuthContext`：那是宿主的认证实现类型（含 session / API Key / environment secret
 * 三条解析路径与 active organization 解析的产物），本包只用其中三个字段，且必须能在包内单测中构造。
 * 声明为本包的窄视图后，宿主的 `AuthContext`、路由此前用的 `authContext`、以及测试里的字面量都是结构等价的
 * 实现，无需任何转换。
 *
 * 边界说明：`role` 是「本次操作的权限意图」而不是身份属性——文件门面把它透传给
 * `getOwnedEnvironment(..., role)`，member 一律 403（fail-closed）。收敛到平台的 `ActorContext` 属于
 * 1.2/1.4 的授权语义统一，届时换成本包对 `ActorContext` 的窄视图；当前先收敛「宿主内部类型」这一项。
 */
export interface MachineRequestAuth {
  /** 当前组织 ID；机器列表与归属校验的第一维隔离条件。 */
  readonly organizationId: string;
  /** 当前用户 ID；与组织共同决定机器的可见范围。 */
  readonly userId: string;
  /** 调用方声明的权限意图（owner/admin 写操作）；缺省表示读操作。 */
  readonly role?: string;
}
