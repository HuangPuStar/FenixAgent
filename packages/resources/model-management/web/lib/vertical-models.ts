/**
 * 垂直模型目录的检索语义。
 *
 * 单独成模块而不是留在页面里：检索是页面的数据流（关键字 → 可见条目集合），页面只负责渲染与状态；
 * 把它留在组件内部会让「命中哪些字段」「空关键字是否过滤」这类规则只能靠渲染整棵 UI 才能验证。
 *
 * 已知边界（与迁移前行为一致，本次只做搬运不做语义修正）：匹配是大小写敏感的 `includes`，且对中文
 * 之外的关键字不做归一化。目录条目全部为中文文案，当前无跨语言检索需求；若将来引入英文条目，
 * 需要在这里统一大小写与空白裁剪，届时补用例。
 */

/** 检索只关心这四个字段；页面数据可以带任意附加字段（图片、效果指标等），不进入本契约。 */
export interface VerticalModelSearchFields {
  name: string;
  description: string;
  tags: readonly string[];
  scenes: readonly string[];
}

/**
 * 按关键字过滤垂直模型目录。
 *
 * 空关键字不过滤（返回全部条目的浅拷贝，调用方不会意外共享同一份数组）；非空时命中名称、描述、
 * 标签或场景任一即保留——四个字段代表用户可能记住的不同信息（"风机"、"合规"、"风电物流"）。
 */
export function filterVerticalModels<T extends VerticalModelSearchFields>(models: readonly T[], search: string): T[] {
  if (!search) return [...models];
  return models.filter(
    (model) =>
      model.name.includes(search) ||
      model.description.includes(search) ||
      model.tags.some((tag) => tag.includes(search)) ||
      model.scenes.some((scene) => scene.includes(search)),
  );
}
