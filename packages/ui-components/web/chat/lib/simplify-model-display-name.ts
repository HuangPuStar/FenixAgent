/**
 * 运行时模型名称的展示化简。
 *
 */

/** 提取运行时模型名称中的 Peri 别名，其他名称保持原样。 */
export function simplifyModelDisplayName(modelName: string): string {
  const periAlias = modelName.match(/\(([^)]+)\)\s*$/i)?.[1]?.trim();
  return periAlias || modelName;
}
