import type {
  ModelCostConfig,
  ModelLimitConfig,
  ModelModalities,
  ModelOptions,
  ModelWriteData,
} from "../repositories/model-resource";

/**
 * 协议 DTO → Model 领域写入数据的转换（迁移自旧 `config/provider.ts` 的 `buildModelData`）。
 *
 * 两条入口的输入形状不同，因此这里有两个函数而不是一个泛化的"取字段"工具：
 *
 * - `/api/models` 用的是对外字段名（`displayName` / `limitConfig`），取值本身就是领域列名，转换只是
 *   "丢掉 `undefined` 的键"；
 * - `/web/config/providers` 用的是配置面板字段名（`name` / `limit`），需要改名。
 *
 * 空值语义与 {@link ModelWriteData} 一致：`undefined` 表示"不修改这一列"，`null` 表示"置空"。旧
 * `buildModelData` 用 `!== undefined` 判断而不是真值判断，正是为了让 `null` 能穿透成"置空"——这里
 * 保持同一判断方式。
 *
 * `modalities` / `cost` / `options` 是自由形状的 jsonb 列，语义由前端与消费方约定，这里只做类型
 * 标注不做 schema 校验：迁移前同样不校验，加校验会让既有配置在保存时突然失败。
 */

/** `/api/models` 的写入体；字段可选，`undefined` 即"不修改"。 */
export interface ApiModelWriteInput {
  readonly displayName?: string | null;
  readonly modalities?: unknown;
  readonly limitConfig?: unknown;
  readonly cost?: unknown;
  readonly options?: unknown;
}

/** `/web/config/providers` 配置面板的模型配置片段；键名来自面板载荷。 */
export interface WebModelConfigInput {
  readonly name?: unknown;
  readonly modalities?: unknown;
  readonly limit?: unknown;
  readonly cost?: unknown;
  readonly options?: unknown;
}

export function modelWriteDataFromApi(input: ApiModelWriteInput): ModelWriteData {
  const data: {
    displayName?: string | null;
    modalities?: ModelModalities | null;
    limitConfig?: ModelLimitConfig | null;
    cost?: ModelCostConfig | null;
    options?: ModelOptions | null;
  } = {};
  if (input.displayName !== undefined) data.displayName = input.displayName;
  if (input.modalities !== undefined) data.modalities = input.modalities as ModelModalities | null;
  if (input.limitConfig !== undefined) data.limitConfig = input.limitConfig as ModelLimitConfig | null;
  if (input.cost !== undefined) data.cost = input.cost as ModelCostConfig | null;
  if (input.options !== undefined) data.options = input.options as ModelOptions | null;
  return data;
}

export function modelWriteDataFromWebConfig(input: WebModelConfigInput): ModelWriteData {
  const data: {
    displayName?: string | null;
    modalities?: ModelModalities | null;
    limitConfig?: ModelLimitConfig | null;
    cost?: ModelCostConfig | null;
    options?: ModelOptions | null;
  } = {};
  if (typeof input.name === "string") data.displayName = input.name;
  if (input.modalities !== undefined) data.modalities = input.modalities as ModelModalities | null;
  if (input.limit !== undefined) data.limitConfig = input.limit as ModelLimitConfig | null;
  if (input.cost !== undefined) data.cost = input.cost as ModelCostConfig | null;
  if (input.options !== undefined) data.options = input.options as ModelOptions | null;
  return data;
}
