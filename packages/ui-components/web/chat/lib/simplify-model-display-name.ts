/**
 * 运行时模型名称的展示化简。
 *
 * 唯一实现。此前本函数有两份逐字相同的副本（本文件与
 * `packages/resources/model-management/web/lib/model-config-utils.ts`），两份都还在仓内——
 * 改名规则的改动只会落在其中一份上，于是「Chat 输入岛显示的模型名」与「模型管理下拉里的模型名」
 * 会在同一屏里对不上。2026-09-22 去重后本文件是 owner，model-management 的 `web/index.ts`
 * 改为从 `@fenix/ui-components/chat/lib/simplify-model-display-name` 转发（该包对外的名字与
 * 子路径不变）。同文件的 `buildModelOptions` 依赖宿主 `ModelEntry` 模型配置类型，属模型管理域，
 * 不随之迁入。
 *
 * 注：`periAlias || modelName` 的 `||` 是有意为之——别名缺失或为空串时回落原始名称，
 * 不能用 `??`（`??` 不会在空串时回落）。
 */

/** 提取运行时模型名称中的 Peri 别名，其他名称保持原样。 */
export function simplifyModelDisplayName(modelName: string): string {
  const periAlias = modelName.match(/\((peri-[^)]+)\)\s*$/i)?.[1]?.trim();
  return periAlias || modelName;
}
