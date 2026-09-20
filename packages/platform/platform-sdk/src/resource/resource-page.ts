/** 资源查询的分页结果；授权过滤必须在数据库查询阶段完成。 */
export interface ResourcePage<TResource> {
  readonly items: readonly TResource[];
  readonly total?: number;
}
