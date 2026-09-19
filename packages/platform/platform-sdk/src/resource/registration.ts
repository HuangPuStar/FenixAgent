import type { ResourceDefinition } from "./authorization";

/**
 * 资源对平台的注册契约：语义定义 + 物理绑定。
 *
 * 资源包声明自己的定义与主表归属列，`apps/server` 汇总后交给平台实现（CE 为
 * `ColumnResourceScopeStore` 与授权查询编译器）。资源包因此不需要知道请求来自哪个 route、
 * 当前 actor 是谁，也不需要复制任何授权 SQL。
 *
 * 类型参数默认 `unknown` 是刻意的：本契约声明在 `platform-sdk`，不得导入 Drizzle 等具体
 * 存储；资源包在自己的注册文件里用自己的 Drizzle 类型实例化，从而保留完整类型校验，
 * 同时不产生「资源包 → 具体 AccessControl 实现」的编译依赖。
 */

/** 主表上承载 `ResourceScope` 的列；未使用的归属列不声明。 */
export interface ResourceScopeColumns<TColumn = unknown> {
  readonly id: TColumn;
  readonly organizationId?: TColumn;
  readonly ownerUserId?: TColumn;
  /** 未声明时该资源不具备公开受众，范围恒为 `private`。 */
  readonly visibility?: TColumn;
}

/** 资源主表与平台范围列的物理映射；只声明列，不解释列语义。 */
export interface ResourceStorageBinding<TTable = unknown, TColumn = unknown> {
  readonly resourceType: string;
  readonly table: TTable;
  readonly columns: ResourceScopeColumns<TColumn>;
}

/** 资源对平台注册的唯一入口。 */
export interface ResourceRegistration<TTable = unknown, TColumn = unknown> {
  readonly definition: ResourceDefinition;
  readonly storage: ResourceStorageBinding<TTable, TColumn>;
}
