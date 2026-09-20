/**
 * 运行时模型名称的展示化简。
 *
 * 来源：复制自 `packages/resources/model-management/web/lib/model-config-utils.ts` 的
 * `simplifyModelDisplayName`（只取 Chat 输入岛用到的这一个函数，同文件的 `buildModelOptions`
 * 依赖宿主 `ModelEntry` 模型配置类型，属模型管理域，未复制）。
 * 纯化改动点：去掉对宿主 `@/src/lib/model-config-utils` 的跨包引用，函数体逐字保留。
 *
 * 注：`periAlias || modelName` 的 `||` 是有意为之——别名缺失或为空串时回落原始名称，
 * 不能用 `??`（`??` 不会在空串时回落）。
 */

/** 提取运行时模型名称中的 Peri 别名，其他名称保持原样。 */
export function simplifyModelDisplayName(modelName: string): string {
  const periAlias = modelName.match(/\((peri-[^)]+)\)\s*$/i)?.[1]?.trim();
  return periAlias || modelName;
}
